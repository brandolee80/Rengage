import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, Alert, StatusBar, SafeAreaView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import useTheme from './useTheme';
import store from './store';
import { loadUsername, saveUsername, getUsername, fetchSubredditPosts, searchSubredditPosts, loadPostLog, logPost, getPostFrequencyWarning, checkFollowUps, fetchInboxReplies } from './reddit';
import { loadApiKey, saveApiKey, hasApiKey, generateCampaignContext, generateReplies, callAI, aiScorePosts } from './ai';
import { scorePost, AI_SCORE_MIN_LOCAL } from './scoring';
import CampaignsList from './CampaignsList';
import CampaignSetup from './CampaignSetup';
import ResultsScreen from './ResultsScreen';
import FollowUpsScreen from './FollowUpsScreen';
import SettingsScreen from './SettingsScreen';

var DEFAULT_PURGE_DAYS = 7;

export default function App() {
  var theme = useTheme();
  var colors = theme.colors;

  var [tab, setTab] = useState('results');
  var [screen, setScreen] = useState(null);
  var [campaigns, setCampaigns] = useState([]);
  var [commentLog, setCommentLog] = useState({});
  var [skippedLog, setSkippedLog] = useState({});
  var [savedPosts, setSavedPosts] = useState([]);
  var [username, setUsername] = useState('');
  var [apiKey, setApiKey] = useState('');
  var [editIndex, setEditIndex] = useState(null);
  var [postLog, setPostLog] = useState([]);
  var [followUpCount, setFollowUpCount] = useState(0);
  var [purgeDays, setPurgeDays] = useState(DEFAULT_PURGE_DAYS);
  var [repollMinutes, setRepollMinutes] = useState(60);
  var [inboxUrl, setInboxUrl] = useState('');
  var [loaded, setLoaded] = useState(false);

  useEffect(function () {
    (async function () {
      await theme.load();
      var name = await loadUsername();
      setUsername(name);
      var key = await loadApiKey();
      setApiKey(key || '');
      var c = await store.get('rengage-campaigns');
      if (c) setCampaigns(c);
      var log = await store.get('rengage-commentlog');
      if (log) setCommentLog(log);
      var skip = await store.get('rengage-skippedlog');
      if (skip) setSkippedLog(skip);
      var posts = await store.get('rengage-savedposts');
      if (posts) setSavedPosts(posts);
      var pl = await loadPostLog();
      setPostLog(pl);
      var pd = await store.get('rengage-purgedays');
      if (pd) setPurgeDays(pd);
      var rm = await store.get('rengage-repollmins');
      if (rm) setRepollMinutes(rm);
      var iu = await store.get('rengage-inbox-url');
      if (iu) setInboxUrl(iu);
      setLoaded(true);
    })();
  }, []);

  // Auto-purge old posts on load
  useEffect(function () {
    if (!loaded || savedPosts.length === 0) return;
    var cutoff = Date.now() - purgeDays * 86400000;
    var cutoffUtc = cutoff / 1000;
    var before = savedPosts.length;
    var filtered = savedPosts.filter(function (p) {
      return p.created_utc > cutoffUtc;
    });
    if (filtered.length < before) {
      setSavedPosts(filtered);
      store.set('rengage-savedposts', filtered);

      // Also clean up comment and skipped logs for purged posts
      var purgedUrls = {};
      savedPosts.forEach(function (p) {
        if (p.created_utc <= cutoffUtc) purgedUrls[p.url] = true;
      });
      var cleanComment = Object.assign({}, commentLog);
      var cleanSkipped = Object.assign({}, skippedLog);
      Object.keys(purgedUrls).forEach(function (url) {
        delete cleanComment[url];
        delete cleanSkipped[url];
      });
      setCommentLog(cleanComment);
      setSkippedLog(cleanSkipped);
      store.set('rengage-commentlog', cleanComment);
      store.set('rengage-skippedlog', cleanSkipped);
    }
  }, [loaded]);

  var saveCampaigns = useCallback(async function (list) {
    setCampaigns(list);
    await store.set('rengage-campaigns', list);
  }, []);

  var saveCommentLog = useCallback(async function (log) {
    setCommentLog(log);
    await store.set('rengage-commentlog', log);
  }, []);

  var saveSkippedLog = useCallback(async function (log) {
    setSkippedLog(log);
    await store.set('rengage-skippedlog', log);
  }, []);

  var saveSavedPosts = useCallback(async function (posts) {
    setSavedPosts(posts);
    await store.set('rengage-savedposts', posts);
  }, []);

  function handleCreateCampaign() { setScreen('newCampaign'); }

  function handleEditCampaign(idx) {
    setEditIndex(idx);
    setScreen('editCampaign');
  }

  // Drop saved posts whose subreddit is no longer covered by any campaign
  // (e.g. you removed a sub because you got banned there).
  function pruneOrphanPosts(campaignList) {
    var valid = {};
    campaignList.forEach(function (c) {
      (c.subs || []).forEach(function (s) {
        valid[s.replace(/^r\//i, '').trim().toLowerCase()] = true;
      });
    });
    setSavedPosts(function (prev) {
      var kept = prev.filter(function (p) { return valid[(p.subreddit || '').toLowerCase()]; });
      if (kept.length === prev.length) return prev;
      store.set('rengage-savedposts', kept);
      return kept;
    });
  }

  function handleDeleteCampaign(idx) {
    Alert.alert('Delete Campaign', 'Delete "' + campaigns[idx].name + '"?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: function () {
          var next = campaigns.slice();
          next.splice(idx, 1);
          saveCampaigns(next);
          pruneOrphanPosts(next);
        }
      },
    ]);
  }

  // Re-run AI scoring on a campaign's saved posts after its context changes.
  // Uses a functional state update so any post a poll appends mid-rescore is
  // preserved (the AI call is async).
  async function rescoreCampaign(oldName, campaign) {
    if (!hasApiKey()) {
      Alert.alert('No API Key', 'Add a Gemini API key in Settings to rescore posts with the new context.');
      return;
    }
    var targets = savedPosts.filter(function (p) { return p._campaign === oldName; });
    if (targets.length === 0) {
      Alert.alert('Nothing to Rescore', 'No saved posts are tagged to this campaign yet.');
      return;
    }
    Alert.alert('Rescoring', 'Updating scores for ' + targets.length + ' post' + (targets.length === 1 ? '' : 's') + '…');

    // Only AI-rescore posts the heuristic rates as promising (saves quota).
    var toScore = targets.filter(function (p) { return scorePost(p, campaign.keywords || []) >= AI_SCORE_MIN_LOCAL; });

    var scoreMap = {};
    if (toScore.length > 0) {
      var aiScores = [];
      try {
        aiScores = await aiScorePosts(toScore, campaign.context);
      } catch (e) {
        console.warn('Rescore failed:', e.message);
      }
      aiScores.forEach(function (s) {
        if (s && s.id && typeof s.score === 'number') scoreMap[s.id] = s;
      });
    }

    var targetIds = {};
    targets.forEach(function (p) { targetIds[p.id] = true; });

    setSavedPosts(function (prev) {
      var updated = prev.map(function (p) {
        if (!targetIds[p.id]) {
          // Posts added after this rescore started: just keep the campaign name in sync.
          if (p._campaign === oldName && oldName !== campaign.name) {
            var rt = Object.assign({}, p);
            rt._campaign = campaign.name;
            return rt;
          }
          return p;
        }
        var np = Object.assign({}, p);
        np._campaign = campaign.name;
        np._context = campaign.context;
        // Only re-blend posts we actually AI-scored; others keep their score.
        if (scoreMap[p.id]) {
          var local = scorePost(p, campaign.keywords || []);
          np._local = local;
          np._ai = scoreMap[p.id].score;
          np._s = Math.round(local * 0.3 + np._ai * 0.7);
          np._aiReason = scoreMap[p.id].reason || '';
        }
        return np;
      });
      store.set('rengage-savedposts', updated);
      return updated;
    });

    var n = Object.keys(scoreMap).length;
    var msg = n > 0 ? ('Rescored ' + n + ' post' + (n === 1 ? '' : 's') + ' with the new context.')
      : toScore.length > 0 ? 'AI rescore failed — kept existing scores.'
      : 'No posts were promising enough to rescore.';
    Alert.alert('Rescore', msg);
  }

  function handleSaveCampaign(campaign) {
    var isEdit = screen === 'editCampaign' && editIndex !== null;
    var oldCampaign = isEdit ? campaigns[editIndex] : null;
    var contextDirty = !!oldCampaign && (oldCampaign.context || '') !== (campaign.context || '');

    var next = campaigns.slice();
    if (isEdit) {
      next[editIndex] = campaign;
    } else {
      next.push(campaign);
    }
    saveCampaigns(next);
    pruneOrphanPosts(next);
    setScreen(null);
    setEditIndex(null);

    if (contextDirty) rescoreCampaign(oldCampaign.name, campaign);
  }

  function handleCancelSetup() {
    setScreen(null);
    setEditIndex(null);
  }

  function handleCommented(url, data) {
    var next = Object.assign({}, commentLog);
    next[url] = data;
    saveCommentLog(next);
  }

  function handleSkipped(url) {
    var next = Object.assign({}, skippedLog);
    next[url] = { at: new Date().toISOString() };
    saveSkippedLog(next);
  }

  async function handleSaveUsername(name) {
    await saveUsername(name);
    setUsername(name);
  }

  async function handleSaveApiKey(key) {
    await saveApiKey(key);
    setApiKey(key);
  }

  async function handleLogPost(subreddit) {
    await logPost(subreddit);
    var pl = await loadPostLog();
    setPostLog(pl);
  }

  async function handleSavePurgeDays(days) {
    setPurgeDays(days);
    await store.set('rengage-purgedays', days);
  }

  async function handleSaveRepollMinutes(mins) {
    setRepollMinutes(mins);
    await store.set('rengage-repollmins', mins);
  }

  async function handleSaveInboxUrl(url) {
    setInboxUrl(url);
    await store.set('rengage-inbox-url', url);
  }

  if (!loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: colors.textMuted }}>Loading...</Text>
      </View>
    );
  }

  // Full-screen views
  if (screen === 'newCampaign' || screen === 'editCampaign') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
        <CampaignSetup
          colors={colors}
          onSave={handleSaveCampaign}
          onCancel={handleCancelSetup}
          existingCampaign={screen === 'editCampaign' ? campaigns[editIndex] : null}
          callAI={callAI}
        />
      </SafeAreaView>
    );
  }

  // Tab content
  var content = null;
  if (tab === 'results') {
    content = (
      <ResultsScreen
        colors={colors}
        campaigns={campaigns}
        commentLog={commentLog}
        skippedLog={skippedLog}
        onCommented={handleCommented}
        onSkipped={handleSkipped}
        savedPosts={savedPosts}
        onSavePosts={saveSavedPosts}
        fetchPosts={fetchSubredditPosts}
        searchPosts={searchSubredditPosts}
        generateReplies={generateReplies}
        aiScorePosts={aiScorePosts}
        username={username}
        getFrequencyWarning={getPostFrequencyWarning}
        onLogPost={handleLogPost}
        purgeDays={purgeDays}
        repollMinutes={repollMinutes}
      />
    );
  } else if (tab === 'followups') {
    content = (
      <FollowUpsScreen
        colors={colors}
        commentLog={commentLog}
        username={username}
        checkFollowUps={checkFollowUps}
        fetchInboxReplies={fetchInboxReplies}
        inboxUrl={inboxUrl}
        generateReplies={generateReplies}
        campaigns={campaigns}
        onLogPost={handleLogPost}
        getFrequencyWarning={getPostFrequencyWarning}
        onCountUpdate={setFollowUpCount}
      />
    );
  } else if (tab === 'campaigns') {
    content = (
      <CampaignsList
        colors={colors}
        campaigns={campaigns}
        commentLog={commentLog}
        onSelect={function () { setTab('results'); }}
        onEdit={handleEditCampaign}
        onDelete={handleDeleteCampaign}
        onCreate={handleCreateCampaign}
      />
    );
  } else if (tab === 'settings') {
    content = (
      <SettingsScreen
        colors={colors}
        isDark={theme.isDark}
        toggleTheme={theme.toggle}
        username={username}
        onSaveUsername={handleSaveUsername}
        apiKey={apiKey}
        onSaveApiKey={handleSaveApiKey}
        postLog={postLog}
        purgeDays={purgeDays}
        onSavePurgeDays={handleSavePurgeDays}
        repollMinutes={repollMinutes}
        onSaveRepollMinutes={handleSaveRepollMinutes}
        inboxUrl={inboxUrl}
        onSaveInboxUrl={handleSaveInboxUrl}
      />
    );
  }

  var tabItems = [
    { key: 'results', label: 'Results', icon: 'search', iconActive: 'search' },
    { key: 'followups', label: 'Follow-Ups', icon: 'chatbubble-ellipses-outline', iconActive: 'chatbubble-ellipses' },
    { key: 'campaigns', label: 'Campaigns', icon: 'layers-outline', iconActive: 'layers' },
    { key: 'settings', label: 'Settings', icon: 'settings-outline', iconActive: 'settings' },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
      <View style={{ flex: 1 }}>{content}</View>
      <View style={{
        flexDirection: 'row', backgroundColor: colors.card,
        borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: 4,
      }}>
        {tabItems.map(function (t) {
          var active = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              onPress={function () { setTab(t.key); }}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 8, position: 'relative' }}
            >
              <Ionicons name={active ? t.iconActive : t.icon} size={22} color={active ? colors.primary : colors.textMuted} />
              <Text style={{
                fontSize: 10, marginTop: 3, fontWeight: active ? '600' : '400',
                color: active ? colors.primary : colors.textMuted,
              }}>{t.label}</Text>
              {t.key === 'followups' && followUpCount > 0 ? (
                <View style={{
                  position: 'absolute', top: 2, right: '20%',
                  backgroundColor: colors.accent, borderRadius: 9,
                  minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center',
                  paddingHorizontal: 4,
                }}>
                  <Text style={{ color: '#000', fontSize: 10, fontWeight: '700' }}>{followUpCount}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}
