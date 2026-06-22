import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Clipboard, Linking, Alert, RefreshControl,
} from 'react-native';
import { scorePost, matchesKeywords, timeAgo } from './scoring';

export default function ResultsScreen({
  colors, campaigns, commentLog, skippedLog, onCommented, onSkipped,
  savedPosts, onSavePosts, fetchPosts, generateReplies, aiScorePosts,
  username, getFrequencyWarning, onLogPost,
}) {
  var [loading, setLoading] = useState(false);
  var [error, setError] = useState(null);
  var [expanded, setExpanded] = useState(null);
  var [replies, setReplies] = useState({});
  var [replyLoading, setReplyLoading] = useState(null);
  var [progress, setProgress] = useState('');
  var [minScore, setMinScore] = useState(10);
  var [filter, setFilter] = useState('new'); // 'new', 'all', 'skipped', 'commented'

  useEffect(function () {
    if (campaigns.length > 0 && savedPosts.length === 0) scan();
  }, []);

  async function scan() {
    if (campaigns.length === 0) {
      setError('Create a campaign first');
      return;
    }
    setLoading(true);
    setError(null);
    setExpanded(null);
    setReplies({});

    // Collect all unique subreddits across campaigns
    var subsMap = {};
    campaigns.forEach(function (c) {
      c.subs.forEach(function (s) {
        var clean = s.replace(/^r\//i, '').trim().toLowerCase();
        if (!subsMap[clean]) subsMap[clean] = [];
        subsMap[clean].push(c);
      });
    });
    var uniqueSubs = Object.keys(subsMap);

    setProgress('Fetching ' + uniqueSubs.length + ' subreddits...');

    try {
      var allRaw = [];
      var fetchedCount = 0;
      var failedSubs = [];

      var fetches = uniqueSubs.map(function (sub) {
        return fetchPosts(sub).then(function (posts) {
          fetchedCount++;
          setProgress('Fetched r/' + sub + ' (' + fetchedCount + '/' + uniqueSubs.length + ') - ' + posts.length + ' posts');
          return posts;
        }).catch(function (e) {
          fetchedCount++;
          failedSubs.push(sub + ': ' + e.message.slice(0, 50));
          setProgress('Failed r/' + sub + ' (' + fetchedCount + '/' + uniqueSubs.length + ')');
          console.warn('Failed r/' + sub + ':', e.message);
          return [];
        });
      });

      var results = await Promise.all(fetches);
      results.forEach(function (r) { allRaw = allRaw.concat(r); });

      if (failedSubs.length > 0) {
        setError(failedSubs.length + ' of ' + uniqueSubs.length + ' subreddits failed:\n' + failedSubs.slice(0, 3).join('\n'));
      }

      if (allRaw.length === 0) {
        setError('No posts fetched. Reddit may be blocking requests. Try setting up the Cloudflare Worker proxy.\n\nFailed: ' + failedSubs.slice(0, 5).join(', '));
        setLoading(false);
        setProgress('');
        return;
      }

      setProgress('Deduping ' + allRaw.length + ' posts...');

      // Dedupe against existing saved posts too
      var existingIds = {};
      savedPosts.forEach(function (p) { existingIds[p.id] = true; });

      var seen = {};
      var newPosts = [];
      allRaw.forEach(function (p) {
        if (!seen[p.id] && !existingIds[p.id]) {
          seen[p.id] = true;
          newPosts.push(p);
        }
      });

      setProgress('Matching keywords across ' + newPosts.length + ' new posts...');

      // Match keywords per campaign and tag posts
      var matched = [];
      var matchSeen = {};
      campaigns.forEach(function (c) {
        newPosts.forEach(function (p) {
          if (matchesKeywords(p, c.keywords) && !matchSeen[p.id + c.name]) {
            matchSeen[p.id + c.name] = true;
            var tagged = Object.assign({}, p);
            tagged._campaign = c.name;
            tagged._context = c.context;
            tagged._s = scorePost(p, c.keywords);
            tagged.age = timeAgo(p.created_utc);
            tagged._fetchedAt = Date.now();
            matched.push(tagged);
          }
        });
      });

      // Filter own posts
      if (username) {
        matched = matched.filter(function (p) {
          return p.author.toLowerCase() !== username.toLowerCase();
        });
      }

      matched.sort(function (a, b) { return b._s - a._s; });

      // Pass 2: AI scoring
      if (matched.length > 0 && aiScorePosts) {
        setProgress('AI scoring ' + matched.length + ' posts...');

        var byCampaign = {};
        matched.forEach(function (p) {
          if (!byCampaign[p._campaign]) byCampaign[p._campaign] = { posts: [], context: p._context };
          byCampaign[p._campaign].posts.push(p);
        });

        var scorePromises = Object.keys(byCampaign).map(function (campName) {
          var group = byCampaign[campName];
          return aiScorePosts(group.posts, group.context).catch(function (e) {
            console.warn('AI scoring failed for', campName, e.message);
            return [];
          });
        });

        try {
          var scoreResults = await Promise.all(scorePromises);
          var scoreMap = {};
          scoreResults.forEach(function (scores) {
            scores.forEach(function (s) {
              if (s.id && typeof s.score === 'number') {
                scoreMap[s.id] = { score: s.score, reason: s.reason || '' };
              }
            });
          });

          matched.forEach(function (p) {
            if (scoreMap[p.id]) {
              p._s = Math.round(p._s * 0.3 + scoreMap[p.id].score * 0.7);
              p._aiReason = scoreMap[p.id].reason;
            }
          });
        } catch (e) {
          console.warn('AI scoring error:', e.message);
        }

        matched.sort(function (a, b) { return b._s - a._s; });
      }

      // Append new posts to saved posts
      var updated = savedPosts.concat(matched);
      onSavePosts(updated);

      setProgress(matched.length + ' new posts found');
      setTimeout(function () { setProgress(''); }, 3000);

      if (matched.length === 0 && savedPosts.length === 0) {
        setError('No keyword matches found. Try broader keywords.');
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  async function handleExpand(post) {
    if (expanded === post.url) { setExpanded(null); return; }
    setExpanded(post.url);
    if (replies[post.url]) return;

    setReplyLoading(post.url);
    try {
      var drafts = await generateReplies(post, post._context);
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

  function handleSkip(post) {
    onSkipped(post.url);
  }

  function badgeStyle(score) {
    var bg = score >= 50 ? colors.green : score >= 25 ? colors.accent : colors.card2;
    var fg = score >= 25 ? '#000' : colors.textMuted;
    return { backgroundColor: bg, color: fg };
  }

  // Filter posts based on current view
  var visible = savedPosts.filter(function (p) {
    var isCommented = !!commentLog[p.url];
    var isSkipped = !!skippedLog[p.url];

    if (filter === 'new') return !isCommented && !isSkipped && p._s >= minScore;
    if (filter === 'skipped') return isSkipped && !isCommented;
    if (filter === 'commented') return isCommented;
    return p._s >= minScore; // 'all'
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

        {/* Controls row */}
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
            onPress={scan}
            disabled={loading}
            style={{
              flex: 1, padding: 10, borderRadius: 8, alignItems: 'center',
              backgroundColor: loading ? colors.card2 : colors.primary,
            }}
          >
            <Text style={{
              color: loading ? colors.textMuted : '#fff',
              fontWeight: '600', fontSize: 14,
            }}>{loading ? 'Scanning...' : 'Scan'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {progress ? (
        <View style={{ marginHorizontal: 20, marginBottom: 8, backgroundColor: colors.card, borderRadius: 8, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={{ color: colors.textSecondary, fontSize: 12, flex: 1 }}>{progress}</Text>
        </View>
      ) : null}
      {error ? <Text style={{ color: colors.red, fontSize: 12, paddingHorizontal: 20, marginBottom: 6 }}>{error}</Text> : null}

      <ScrollView
        style={{ flex: 1, paddingHorizontal: 20 }}
        refreshControl={
          React.createElement(RefreshControl, {
            refreshing: loading,
            onRefresh: scan,
            tintColor: colors.primary,
          })
        }
      >
        {visible.map(function (post, idx) {
          var isOpen = expanded === post.url;
          var isCommented = !!commentLog[post.url];
          var isSkipped = !!skippedLog[post.url];
          var bs = badgeStyle(post._s);

          return (
            <View key={post.url + idx} style={{
              backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
              borderRadius: 10, padding: 14, marginBottom: 8,
              opacity: isCommented ? 0.4 : isSkipped ? 0.5 : 1,
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

                  {/* Skip button */}
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

        {!loading && visible.length === 0 && !error ? (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <Text style={{ color: colors.textMuted, fontSize: 14 }}>
              {campaigns.length === 0 ? 'Create a campaign first' :
               filter === 'new' ? 'No new posts. Pull to scan.' :
               filter === 'commented' ? 'No commented posts yet.' :
               filter === 'skipped' ? 'No skipped posts.' :
               'No posts found. Tap Scan.'}
            </Text>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}
