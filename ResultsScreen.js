import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Clipboard, Linking, Alert, RefreshControl, AppState,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { scorePost, matchesKeywords, timeAgo, AI_SCORE_MIN_LOCAL } from './scoring';
import { getAiBudget } from './ai';
import store from './store';

// ── Polling cadence (tunable) ──
var TICK_MS = 2000;             // how often the loop wakes to check for work
var MIN_GAP_MS = 12000;         // floor between any two polls (rate safety)
var AUTO_INTERVAL_MS = 60000;   // automatic trickle: ~1 sub per minute
var DEFAULT_REPOLL_MIN = 60;    // re-poll interval (minutes) if Settings value missing
var RETRY_FAIL_MS = 10 * 60000; // failed sources retry sooner than the full interval
var COOLDOWN_MS = 12 * 60000;   // pause after Reddit blocks us
var MAX_POST_AGE_DAYS = 7;      // fallback max age for matches (overridden by purgeDays)

function formatLastPolled(ms) {
  if (!ms) return 'never';
  var diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

// Build a Reddit search query from a list of keywords (OR'd; multi-word quoted).
function buildQuery(keywords) {
  return (keywords || []).map(function (k) {
    return k.indexOf(' ') >= 0 ? '"' + k + '"' : k;
  }).join(' OR ');
}

export default function ResultsScreen({
  colors, campaigns, commentLog, skippedLog, onCommented, onSkipped,
  savedPosts, onSavePosts, fetchPosts, searchPosts, generateReplies, aiScorePosts,
  username, getFrequencyWarning, onLogPost, purgeDays, repollMinutes,
}) {
  var repollMs = (repollMinutes > 0 ? repollMinutes : DEFAULT_REPOLL_MIN) * 60000;
  var [error, setError] = useState(null);
  var [expanded, setExpanded] = useState(null);
  var [replies, setReplies] = useState({});
  var [replyLoading, setReplyLoading] = useState(null);
  var [minScore, setMinScore] = useState(10);
  var [filter, setFilter] = useState('new');
  var [pollStatus, setPollStatus] = useState({});
  var [activeSub, setActiveSub] = useState(null);
  var [scoringActive, setScoringActive] = useState(false);
  var [showSources, setShowSources] = useState(false);
  var [cooldownUntil, setCooldownUntil] = useState(0);
  var [tick, setTick] = useState(0); // forces re-render so "last polled" stays current

  // Distinct subreddits across all campaigns, plus the union of keywords that
  // target each sub (so we can search the sub for *any* relevant campaign term).
  var distinctSubs = [];
  var subSeen = {};
  var subKeywords = {}; // sub -> [keywords]
  campaigns.forEach(function (c) {
    (c.subs || []).forEach(function (s) {
      var clean = s.replace(/^r\//i, '').trim().toLowerCase();
      if (!clean) return;
      if (!subSeen[clean]) { subSeen[clean] = true; distinctSubs.push(clean); subKeywords[clean] = []; }
      (c.keywords || []).forEach(function (kw) {
        if (subKeywords[clean].indexOf(kw) === -1) subKeywords[clean].push(kw);
      });
    });
  });

  // ── Refs the polling loop reads (kept in sync each render to avoid stale closures) ──
  var savedPostsRef = useRef(savedPosts);
  var campaignsRef = useRef(campaigns);
  var subsRef = useRef(distinctSubs);
  var subKeywordsRef = useRef(subKeywords);
  var pollStatusRef = useRef(pollStatus);
  var usernameRef = useRef(username);
  var lockRef = useRef(false);
  var lastPollAtRef = useRef(0);
  var cooldownUntilRef = useRef(0);
  var queueRef = useRef([]);
  var appActiveRef = useRef(true);
  var tickFnRef = useRef(null);
  var repollMsRef = useRef(repollMs);

  useEffect(function () {
    savedPostsRef.current = savedPosts;
    campaignsRef.current = campaigns;
    subsRef.current = distinctSubs;
    subKeywordsRef.current = subKeywords;
    pollStatusRef.current = pollStatus;
    usernameRef.current = username;
    repollMsRef.current = repollMs;
  });

  // Load persisted poll status once
  useEffect(function () {
    (async function () {
      var saved = await store.get('rengage-pollstatus');
      if (saved) { setPollStatus(saved); pollStatusRef.current = saved; }
    })();
  }, []);

  // Drop poll-status for subs no longer in any campaign (e.g. removed/banned).
  useEffect(function () {
    var valid = {};
    distinctSubs.forEach(function (s) { valid[s] = true; });
    var orphans = Object.keys(pollStatus).filter(function (s) { return !valid[s]; });
    if (orphans.length === 0) return;
    var cleaned = {};
    Object.keys(pollStatus).forEach(function (s) { if (valid[s]) cleaned[s] = pollStatus[s]; });
    pollStatusRef.current = cleaned;
    setPollStatus(cleaned);
    store.set('rengage-pollstatus', cleaned);
  }, [distinctSubs.join(','), pollStatus]);

  function updatePollStatus(sub, data) {
    setPollStatus(function (prev) {
      var next = Object.assign({}, prev);
      next[sub] = Object.assign({}, prev[sub], data);
      pollStatusRef.current = next;
      store.set('rengage-pollstatus', next);
      return next;
    });
  }

  // Merge freshly fetched posts into the saved feed (dedupe, match, score).
  async function ingestRawPosts(rawPosts) {
    var current = savedPostsRef.current || [];
    var existingIds = {};
    current.forEach(function (p) { existingIds[p.id] = true; });

    var maxAgeDays = purgeDays > 0 ? purgeDays : MAX_POST_AGE_DAYS;
    var minCreated = Date.now() / 1000 - maxAgeDays * 86400;
    var seen = {};
    var recent = 0;       // distinct posts within the freshness window
    var newPosts = [];    // recent posts not already saved
    rawPosts.forEach(function (p) {
      if (seen[p.id]) return;
      seen[p.id] = true;
      // Keyword search can reach far back; skip stale posts not worth engaging.
      if (p.created_utc && p.created_utc < minCreated) return;
      recent++;
      if (existingIds[p.id]) return;
      newPosts.push(p);
    });
    if (newPosts.length === 0) return { added: 0, recent: recent };

    var camps = campaignsRef.current;
    function subTargets(c, sub) {
      return (c.subs || []).some(function (s) {
        return s.replace(/^r\//i, '').trim().toLowerCase() === sub;
      });
    }

    var matched = [];
    var matchSeen = {};
    newPosts.forEach(function (p) {
      var sub = (p.subreddit || '').toLowerCase();
      // Prefer campaigns whose keywords literally appear in the post (precise
      // tag). Otherwise trust Reddit's search — the post came back for this
      // sub's keywords — and attribute it to one campaign that targets the sub.
      var strict = camps.filter(function (c) { return matchesKeywords(p, c.keywords); });
      var assigned;
      if (strict.length > 0) {
        assigned = strict;
      } else {
        var subCamps = camps.filter(function (c) { return subTargets(c, sub); });
        assigned = subCamps.length > 0 ? [subCamps[0]] : [];
      }
      assigned.forEach(function (c) {
        if (matchSeen[p.id + c.name]) return;
        matchSeen[p.id + c.name] = true;
        var tagged = Object.assign({}, p);
        tagged._campaign = c.name;
        tagged._context = c.context;
        tagged._local = scorePost(p, c.keywords);
        tagged._s = tagged._local;   // blended score (becomes local*0.3 + ai*0.7 once scored)
        tagged._ai = null;           // null = not AI-scored yet
        tagged.age = timeAgo(p.created_utc);
        tagged._fetchedAt = Date.now();
        matched.push(tagged);
      });
    });

    var user = usernameRef.current;
    if (user) {
      matched = matched.filter(function (p) { return p.author.toLowerCase() !== user.toLowerCase(); });
    }
    if (matched.length === 0) return { added: 0, recent: recent };

    // AI scoring (best-effort) — only refine posts the heuristic already rates
    // as promising; low scorers keep their local score and cost no Gemini quota.
    var toScore = matched.filter(function (p) { return p._local >= AI_SCORE_MIN_LOCAL; });
    if (aiScorePosts && toScore.length > 0) {
      var byCampaign = {};
      toScore.forEach(function (p) {
        if (!byCampaign[p._campaign]) byCampaign[p._campaign] = { posts: [], context: p._context };
        byCampaign[p._campaign].posts.push(p);
      });
      try {
        var results = await Promise.all(Object.keys(byCampaign).map(function (cn) {
          return aiScorePosts(byCampaign[cn].posts, byCampaign[cn].context).catch(function () { return []; });
        }));
        var scoreMap = {};
        results.forEach(function (scores) {
          scores.forEach(function (s) {
            if (s.id && typeof s.score === 'number') scoreMap[s.id] = { score: s.score, reason: s.reason || '' };
          });
        });
        matched.forEach(function (p) {
          if (scoreMap[p.id]) {
            p._ai = scoreMap[p.id].score;
            p._s = Math.round(p._local * 0.3 + p._ai * 0.7);
            p._aiReason = scoreMap[p.id].reason;
          }
        });
      } catch (e) {
        console.warn('AI scoring error:', e.message);
      }
    }

    var updated = current.concat(matched);
    savedPostsRef.current = updated;
    onSavePosts(updated);
    return { added: matched.length, recent: recent };
  }

  // Poll a single subreddit. Serialized by lockRef so only one runs at a time.
  async function pollSub(sub) {
    lockRef.current = true;
    lastPollAtRef.current = Date.now();
    queueRef.current = queueRef.current.filter(function (s) { return s !== sub; });
    setActiveSub(sub);
    try {
      // Search the sub for its campaigns' keywords so results are relevant,
      // rather than pulling the newest posts and hoping they match.
      var query = buildQuery(subKeywordsRef.current[sub]);
      var posts = (query && searchPosts) ? await searchPosts(sub, query) : await fetchPosts(sub);
      var res = await ingestRawPosts(posts);
      updatePollStatus(sub, { lastPolled: Date.now(), lastSuccess: Date.now(), status: 'ok', fetched: posts.length, recent: res.recent, added: res.added, error: null });
    } catch (e) {
      var blocked = e.message.indexOf('Blocked') !== -1;
      if (blocked) {
        cooldownUntilRef.current = Date.now() + COOLDOWN_MS;
        setCooldownUntil(cooldownUntilRef.current);
      }
      updatePollStatus(sub, { lastPolled: Date.now(), status: blocked ? 'blocked' : 'error', error: e.message.slice(0, 60) });
      console.warn('Poll failed r/' + sub + ':', e.message);
    }
    setActiveSub(null);
    lockRef.current = false;
  }

  // Posts that are promising enough for AI but haven't been scored yet (e.g.
  // ingested while the Gemini budget was capped). These get scored later.
  function pendingScorePosts() {
    return (savedPostsRef.current || []).filter(function (p) {
      if (!p._campaign || p._ai != null || p._aiReason || p._aiTried) return false;
      var local = (typeof p._local === 'number') ? p._local : p._s;
      return local >= AI_SCORE_MIN_LOCAL;
    });
  }

  // Catch-up: AI-score a batch of pending posts when there's budget. Runs in the
  // idle slots of the trickle, serialized by the same lock as sub polling.
  async function scorePendingBatch() {
    var pending = pendingScorePosts();
    if (pending.length === 0 || !aiScorePosts) return;
    var budget;
    try { budget = await getAiBudget(); } catch (e) { return; }
    if (budget.used >= budget.limit) return; // capped — try again later (resets daily)

    lockRef.current = true;
    lastPollAtRef.current = Date.now();
    setScoringActive(true);
    try {
      var batch = pending.slice(0, 20);
      var batchIds = {};
      batch.forEach(function (p) { batchIds[p.id] = true; });

      var byCampaign = {};
      batch.forEach(function (p) {
        var camp = campaignsRef.current.filter(function (c) { return c.name === p._campaign; })[0];
        var ctx = camp ? camp.context : p._context;
        if (!byCampaign[p._campaign]) byCampaign[p._campaign] = { posts: [], context: ctx };
        byCampaign[p._campaign].posts.push(p);
      });

      var results = await Promise.all(Object.keys(byCampaign).map(function (cn) {
        return aiScorePosts(byCampaign[cn].posts, byCampaign[cn].context).catch(function () { return []; });
      }));
      var scoreMap = {};
      results.forEach(function (scores) {
        scores.forEach(function (s) {
          if (s && s.id && typeof s.score === 'number') scoreMap[s.id] = { score: s.score, reason: s.reason || '' };
        });
      });

      // Only persist if the AI actually returned scores (so a capped/failed call
      // leaves posts pending for a real retry rather than marking them done).
      if (Object.keys(scoreMap).length > 0) {
        var cur = savedPostsRef.current || [];
        var updated = cur.map(function (p) {
          if (scoreMap[p.id]) {
            var np = Object.assign({}, p);
            np._local = (typeof p._local === 'number') ? p._local : p._s;
            np._ai = scoreMap[p.id].score;
            np._s = Math.round(np._local * 0.3 + np._ai * 0.7);
            np._aiReason = scoreMap[p.id].reason;
            return np;
          }
          // In this batch but AI skipped it: mark tried so we don't retry forever.
          if (batchIds[p.id]) {
            var nt = Object.assign({}, p);
            nt._aiTried = true;
            return nt;
          }
          return p;
        });
        savedPostsRef.current = updated;
        onSavePosts(updated);
      }
    } catch (e) {
      console.warn('Catch-up scoring failed:', e.message);
    }
    setScoringActive(false);
    lockRef.current = false;
  }

  // Decide what to poll next: queued (forced) subs first, then stalest stale sub.
  function nextSub(now) {
    if (lockRef.current || !appActiveRef.current || now < cooldownUntilRef.current) return null;

    if (queueRef.current.length > 0) {
      return (now - lastPollAtRef.current >= MIN_GAP_MS) ? queueRef.current[0] : null;
    }
    if (now - lastPollAtRef.current < AUTO_INTERVAL_MS) return null;

    var stalest = null;
    var stalestAt = Infinity;
    subsRef.current.forEach(function (s) {
      var st = pollStatusRef.current[s] || {};
      var last = st.lastPolled || 0;
      var failed = st.status === 'error' || st.status === 'blocked';
      // Successful sources wait the full interval (measured from last success);
      // failed/never-polled ones become eligible again sooner so they recover.
      var interval = failed ? RETRY_FAIL_MS : repollMsRef.current;
      var since = (st.status === 'ok' && st.lastSuccess) ? (now - st.lastSuccess) : (now - last);
      if (since >= interval && last < stalestAt) { stalest = s; stalestAt = last; }
    });
    return stalest;
  }

  // tickFnRef always points at the latest closure; the interval calls it.
  // Polling runs off refs, so it works without re-rendering; we only nudge a
  // re-render to keep "last polled"/cooldown labels live when they're visible.
  tickFnRef.current = function () {
    if (showSources || activeSub || scoringActive || cooldownUntil > Date.now()) {
      setTick(function (t) { return (t + 1) % 1000000; });
    }
    var now = Date.now();
    var sub = nextSub(now);
    if (sub) { pollSub(sub); return; }
    // No sub due to poll — use the idle slot to catch up on unscored posts.
    if (!lockRef.current && appActiveRef.current && now >= cooldownUntilRef.current &&
        now - lastPollAtRef.current >= AUTO_INTERVAL_MS) {
      scorePendingBatch();
    }
  };

  useEffect(function () {
    var id = setInterval(function () { if (tickFnRef.current) tickFnRef.current(); }, TICK_MS);
    var sub = AppState.addEventListener('change', function (state) {
      appActiveRef.current = (state === 'active');
    });
    return function () {
      clearInterval(id);
      if (sub && sub.remove) sub.remove();
    };
  }, []);

  function forceSub(s) {
    if (queueRef.current.indexOf(s) === -1) queueRef.current.push(s);
    setTick(function (t) { return t + 1; });
  }

  function forceAll() {
    subsRef.current.forEach(function (s) {
      if (queueRef.current.indexOf(s) === -1) queueRef.current.push(s);
    });
    setTick(function (t) { return t + 1; });
  }

  async function handleExpand(post) {
    if (expanded === post.url) { setExpanded(null); return; }
    setExpanded(post.url);
    if (replies[post.url]) return;

    setReplyLoading(post.url);
    try {
      // Use the campaign's *current* context (falls back to the snapshot saved
      // with the post) so editing context immediately improves suggestions.
      var camp = campaigns.filter(function (c) { return c.name === post._campaign; })[0];
      var ctx = camp ? camp.context : post._context;
      var drafts = await generateReplies(post, ctx);
      var next = Object.assign({}, replies);
      next[post.url] = drafts;
      setReplies(next);
    } catch (e) {
      var next2 = Object.assign({}, replies);
      next2[post.url] = [{ text: 'Error: ' + e.message, approach: 'Error', recommended: true }];
      setReplies(next2);
    }
    setReplyLoading(null);
  }

  function handleComment(post, replyText) {
    var warning = getFrequencyWarning ? getFrequencyWarning(post.subreddit) : null;
    if (warning) {
      Alert.alert('Slow Down', warning, [
        { text: 'Rengage Anyway', onPress: function () { doComment(post, replyText); } },
        { text: 'Cancel', style: 'cancel' },
      ]);
    } else {
      doComment(post, replyText);
    }
  }

  function doComment(post, replyText) {
    Clipboard.setString(replyText);
    if (onLogPost) onLogPost(post.subreddit);
    onCommented(post.url, {
      title: post.title,
      sub: post.subreddit,
      campaign: post._campaign,
      at: new Date().toISOString(),
      text: replyText,
    });
    Linking.openURL(post.url);
    Alert.alert('Reply Copied', 'Paste your reply in Reddit.');
  }

  function handleSkip(post) { onSkipped(post.url); }

  function badgeStyle(score) {
    var bg = score >= 50 ? colors.green : score >= 25 ? colors.accent : colors.card2;
    var fg = score >= 25 ? '#000' : colors.textMuted;
    return { backgroundColor: bg, color: fg };
  }

  // ── Source row status helpers ──
  function subState(sub) {
    if (activeSub === sub) return 'polling';
    var st = pollStatus[sub];
    if (!st || !st.lastPolled) return 'never';
    if (st.status === 'blocked') return 'blocked';
    if (st.status === 'error') return 'error';
    if (Date.now() - st.lastPolled < repollMs) return 'fresh';
    return 'stale';
  }

  function renderStateIcon(state) {
    if (state === 'polling') return <ActivityIndicator size="small" color={colors.textSecondary} />;
    var map = {
      fresh: { name: 'checkmark-circle', color: colors.green },
      stale: { name: 'time-outline', color: colors.accent },
      never: { name: 'ellipse-outline', color: colors.textMuted },
      blocked: { name: 'ban', color: colors.red },
      error: { name: 'warning-outline', color: colors.red },
    };
    var i = map[state] || map.never;
    return <Ionicons name={i.name} size={18} color={i.color} />;
  }

  var freshCount = distinctSubs.filter(function (s) { return subState(s) === 'fresh'; }).length;
  var cooldownActive = cooldownUntil > Date.now();
  var windowDays = purgeDays > 0 ? purgeDays : MAX_POST_AGE_DAYS;

  // ── Feed filtering (main view) ──
  var visible = savedPosts.filter(function (p) {
    var isCommented = !!commentLog[p.url];
    var isSkipped = !!skippedLog[p.url];
    if (filter === 'new') return !isCommented && !isSkipped && p._s >= minScore;
    if (filter === 'skipped') return isSkipped && !isCommented;
    if (filter === 'commented') return isCommented;
    return p._s >= minScore;
  });
  visible.sort(function (a, b) { return b._s - a._s; });

  var newCount = savedPosts.filter(function (p) { return !commentLog[p.url] && !skippedLog[p.url] && p._s >= minScore; }).length;
  var commentedCount = savedPosts.filter(function (p) { return !!commentLog[p.url]; }).length;
  var skippedCount = savedPosts.filter(function (p) { return !!skippedLog[p.url] && !commentLog[p.url]; }).length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 20, paddingBottom: 0 }}>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 12 }}>Results</Text>

        {/* Filter tabs */}
        <View style={{ flexDirection: 'row', backgroundColor: colors.card2, borderRadius: 8, padding: 3, marginBottom: 12 }}>
          {[
            { key: 'new', label: 'New', count: newCount },
            { key: 'commented', label: 'Commented', count: commentedCount },
            { key: 'skipped', label: 'Skipped', count: skippedCount },
            { key: 'all', label: 'All', count: savedPosts.length },
          ].map(function (f) {
            var active = filter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={function () { setFilter(f.key); }}
                style={{
                  flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6,
                  backgroundColor: active ? colors.card : 'transparent',
                }}
              >
                <Text style={{
                  color: active ? colors.text : colors.textMuted,
                  fontSize: 11, fontWeight: active ? '600' : '400',
                }}>{f.label} ({f.count})</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Controls row: min score + Sources toggle + refresh-all */}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>Min</Text>
          <TextInput
            style={{
              width: 40, padding: 6, fontSize: 12, borderRadius: 4, textAlign: 'center',
              borderWidth: 1, borderColor: colors.inputBorder, backgroundColor: colors.inputBg,
              color: colors.text,
            }}
            value={String(minScore)}
            onChangeText={function (v) { setMinScore(parseInt(v) || 0); }}
            keyboardType="number-pad"
          />
          <TouchableOpacity
            onPress={function () { setShowSources(!showSources); }}
            style={{
              flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6,
              padding: 10, borderRadius: 8, backgroundColor: colors.card2,
            }}
          >
            <Ionicons name="radio-outline" size={15} color={colors.text} />
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>
              Sources {freshCount}/{distinctSubs.length}
            </Text>
            <Ionicons name={showSources ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={forceAll}
            style={{ padding: 10, borderRadius: 8, backgroundColor: colors.primary }}
          >
            <Ionicons name="refresh" size={16} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Sources panel */}
        {showSources ? (
          <View style={{ backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginBottom: 12, overflow: 'hidden', maxHeight: 260 }}>
            {distinctSubs.length === 0 ? (
              <Text style={{ color: colors.textMuted, fontSize: 12, padding: 14 }}>No subreddits. Add subs to a campaign.</Text>
            ) : (
              <ScrollView nestedScrollEnabled={true}>
                {distinctSubs.map(function (sub, i) {
              var st = pollStatus[sub] || {};
              var state = subState(sub);
              return (
                <View key={sub} style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12,
                  borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border,
                }}>
                  <View style={{ width: 20, alignItems: 'center' }}>{renderStateIcon(state)}</View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '500' }}>r/{sub}</Text>
                    <Text style={{ color: state === 'blocked' || state === 'error' ? colors.red : colors.textMuted, fontSize: 11, marginTop: 1 }}>
                      {state === 'polling' ? 'polling…'
                        : state === 'blocked' ? 'blocked — cooling down'
                        : state === 'error' ? (st.error || 'error')
                        : !st.lastPolled ? 'never polled'
                        : formatLastPolled(st.lastSuccess || st.lastPolled) + ' · ' + (st.fetched || 0) + ' found, ' + (st.recent || 0) + ' in ' + windowDays + 'd, ' + (st.added || 0) + ' new'}
                    </Text>
                    {(state === 'blocked' || state === 'error') ? (
                      <Text style={{ color: colors.textMuted, fontSize: 10, marginTop: 1 }}>
                        {st.lastSuccess
                          ? 'last ok ' + formatLastPolled(st.lastSuccess) + ' · ' + (st.fetched || 0) + ' found'
                          : 'no successful poll yet · tried ' + formatLastPolled(st.lastPolled)}
                      </Text>
                    ) : null}
                  </View>
                  <TouchableOpacity
                    onPress={function () { forceSub(sub); }}
                    disabled={activeSub === sub}
                    style={{ padding: 6 }}
                  >
                    <Ionicons name="refresh" size={16} color={activeSub === sub ? colors.textMuted : colors.primary} />
                  </TouchableOpacity>
                </View>
              );
                })}
              </ScrollView>
            )}
          </View>
        ) : null}
      </View>

      {activeSub ? (
        <View style={{ marginHorizontal: 20, marginBottom: 8, backgroundColor: colors.card, borderRadius: 8, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={{ color: colors.textSecondary, fontSize: 12, flex: 1 }}>Polling r/{activeSub}…</Text>
        </View>
      ) : scoringActive ? (
        <View style={{ marginHorizontal: 20, marginBottom: 8, backgroundColor: colors.card, borderRadius: 8, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={{ color: colors.textSecondary, fontSize: 12, flex: 1 }}>AI-scoring saved posts…</Text>
        </View>
      ) : null}
      {cooldownActive ? (
        <Text style={{ color: colors.accent, fontSize: 11, paddingHorizontal: 20, marginBottom: 6 }}>
          Reddit rate-limited us. Polling paused ~{Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 60000))}m.
        </Text>
      ) : null}
      {error ? <Text style={{ color: colors.red, fontSize: 12, paddingHorizontal: 20, marginBottom: 6 }}>{error}</Text> : null}

      <ScrollView
        style={{ flex: 1, paddingHorizontal: 20 }}
        refreshControl={
          React.createElement(RefreshControl, {
            refreshing: !!activeSub,
            onRefresh: forceAll,
            tintColor: colors.primary,
          })
        }
      >
        {visible.map(function (post, idx) {
          var isOpen = expanded === post.url;
          var isCommented = !!commentLog[post.url];
          var isSkipped = !!skippedLog[post.url];
          var bs = badgeStyle(post._s);

          // Older posts (pre-split) only stored the blended score. Recompute the
          // true local heuristic from the campaign's keywords so "local" is honest.
          var localScore;
          if (typeof post._local === 'number') {
            localScore = post._local;
          } else {
            var camp = campaigns.filter(function (c) { return c.name === post._campaign; })[0];
            localScore = camp ? scorePost(post, camp.keywords) : post._s;
          }

          // AI score: use the stored value, else invert the blend for old posts
          // that were AI-scored (overall = local*0.3 + ai*0.7).
          var aiScore = null;
          if (typeof post._ai === 'number') {
            aiScore = post._ai;
          } else if (post._aiReason) {
            aiScore = Math.max(0, Math.min(100, Math.round((post._s - localScore * 0.3) / 0.7)));
          }
          // "pending" only if it's promising enough to actually get scored later;
          // low scorers are deliberately skipped (saves quota) and won't update.
          var aiPending = aiScore == null && !post._aiTried && localScore >= AI_SCORE_MIN_LOCAL;
          var aiLabel = aiScore != null ? 'AI ' + aiScore
            : post._aiTried ? 'AI n/a'
            : aiPending ? 'AI pending'
            : 'AI skipped';

          return (
            <View key={post.url + idx} style={{
              backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
              borderRadius: 10, padding: 14, marginBottom: 8,
              // Dim to flag "already handled" only in mixed views — not on the
              // dedicated Commented/Skipped tabs where every item shares that state.
              opacity: (isCommented && filter !== 'commented') ? 0.4
                : (isSkipped && filter !== 'skipped') ? 0.5 : 1,
            }}>
              <TouchableOpacity onPress={function () { handleExpand(post); }} activeOpacity={0.7}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                  <View style={{
                    backgroundColor: bs.backgroundColor, paddingHorizontal: 8, paddingVertical: 3,
                    borderRadius: 4, minWidth: 30, alignItems: 'center',
                  }}>
                    <Text style={{ color: bs.color, fontSize: 11, fontWeight: '700' }}>{post._s}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500', lineHeight: 20 }}>{post.title}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                      <Text style={{ color: colors.primary, fontSize: 11 }}>r/{post.subreddit}</Text>
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>{post.age}</Text>
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>{post.num_comments} comments</Text>
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>u/{post.author}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 3 }}>
                      <Text style={{ color: colors.textMuted, fontSize: 10 }}>
                        local {localScore}
                      </Text>
                      <Text style={{ color: aiPending ? colors.accent : colors.textMuted, fontSize: 10 }}>
                        {aiLabel}
                      </Text>
                    </View>
                    {post._campaign ? (
                      <View style={{ marginTop: 4, backgroundColor: colors.primaryDim, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, alignSelf: 'flex-start' }}>
                        <Text style={{ color: colors.primary, fontSize: 10, fontWeight: '600' }}>{post._campaign}</Text>
                      </View>
                    ) : null}
                    {isCommented ? <Text style={{ color: colors.green, fontSize: 11, fontWeight: '600', marginTop: 4 }}>Commented</Text> : null}
                    {isSkipped ? <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600', marginTop: 4 }}>Skipped</Text> : null}
                    {post._aiReason ? <Text style={{ color: colors.accent, fontSize: 10, marginTop: 3, fontStyle: 'italic' }}>{post._aiReason}</Text> : null}
                  </View>
                </View>
                {post.selftext ? (
                  <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 8, lineHeight: 18 }} numberOfLines={isOpen ? 20 : 2}>
                    {post.selftext}
                  </Text>
                ) : null}
              </TouchableOpacity>

              {isOpen ? (
                <View style={{ marginTop: 14 }}>
                  {replyLoading === post.url ? (
                    <View style={{ padding: 20, alignItems: 'center' }}>
                      <ActivityIndicator color={colors.primary} />
                      <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 8 }}>Drafting replies...</Text>
                    </View>
                  ) : null}

                  {replies[post.url] ? replies[post.url].map(function (r, ri) {
                    var isRec = r.recommended;
                    return (
                      <View key={ri} style={{
                        borderWidth: 1, borderColor: isRec ? colors.green : colors.border,
                        borderRadius: 8, padding: 12, marginBottom: 8,
                        backgroundColor: isRec ? colors.greenDim : colors.inputBg,
                      }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                          <Text style={{ color: colors.textMuted, fontSize: 12 }}>{r.approach}</Text>
                          {isRec ? (
                            <View style={{ backgroundColor: colors.green, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3 }}>
                              <Text style={{ color: '#000', fontSize: 9, fontWeight: '700', textTransform: 'uppercase' }}>Best fit</Text>
                            </View>
                          ) : null}
                        </View>
                        <TextInput
                          style={{
                            backgroundColor: 'rgba(0,0,0,0.2)', borderWidth: 1, borderColor: colors.inputBorder,
                            borderRadius: 6, color: colors.text, padding: 10, fontSize: 13,
                            lineHeight: 19, minHeight: 80, textAlignVertical: 'top',
                          }}
                          multiline
                          defaultValue={r.text}
                          onChangeText={function (t) { r.text = t; }}
                        />
                        <TouchableOpacity
                          onPress={function () { handleComment(post, r.text); }}
                          style={{
                            marginTop: 8, padding: 10, borderRadius: 6, alignItems: 'center',
                            backgroundColor: isRec ? colors.green : colors.card2,
                          }}
                        >
                          <Text style={{ color: isRec ? '#000' : colors.text, fontWeight: '600', fontSize: 13 }}>
                            Rengage
                          </Text>
                        </TouchableOpacity>
                      </View>
                    );
                  }) : null}

                  {!commentLog[post.url] && !skippedLog[post.url] ? (
                    <TouchableOpacity
                      onPress={function () { handleSkip(post); setExpanded(null); }}
                      style={{ padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.card2, marginTop: 4 }}
                    >
                      <Text style={{ color: colors.textMuted, fontSize: 13 }}>Skip</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}

        {visible.length === 0 && !error ? (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
              {campaigns.length === 0 ? 'Create a campaign first' :
               filter === 'new' ? 'No new posts yet.\nSubreddits poll automatically — open Sources to watch.' :
               filter === 'commented' ? 'No commented posts yet.' :
               filter === 'skipped' ? 'No skipped posts.' :
               'No posts yet. Tap refresh to poll now.'}
            </Text>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}
