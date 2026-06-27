import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  ActivityIndicator, Linking, Alert, Clipboard,
} from 'react-native';
import { timeAgo } from './scoring';
import store from './store';

export default function FollowUpsScreen({
  colors, commentLog, username, checkFollowUps, fetchInboxReplies, inboxUrl,
  generateReplies, campaigns, onLogPost, getFrequencyWarning,
  onCountUpdate, onRengaged, rengageCooldownMins, lastRengageAt,
}) {
  var rengageUntil = (lastRengageAt || 0) + (rengageCooldownMins || 0) * 60000;
  var rengageRemainingMs = rengageUntil - Date.now();
  var rengageActive = rengageRemainingMs > 0;
  var rengageRemainingMin = Math.ceil(rengageRemainingMs / 60000);
  var [followUps, setFollowUps] = useState([]);
  var [loading, setLoading] = useState(false);
  var [error, setError] = useState(null);
  var [expanded, setExpanded] = useState(null);
  var [replies, setReplies] = useState({});
  var [replyLoading, setReplyLoading] = useState(null);
  var [lastChecked, setLastChecked] = useState(null);
  var [handled, setHandled] = useState({}); // reply link -> dismissed-at timestamp
  var [, setClockTick] = useState(0);

  // Re-render periodically so the Rengage cooldown counts down and re-enables.
  useEffect(function () {
    var id = setInterval(function () { setClockTick(function (t) { return t + 1; }); }, 10000);
    return function () { clearInterval(id); };
  }, []);

  useEffect(function () {
    refresh();
  }, [inboxUrl, username]);

  // Load dismissed follow-ups, pruning entries older than 60 days.
  useEffect(function () {
    (async function () {
      var h = await store.get('rengage-followup-handled');
      if (!h) return;
      var cutoff = Date.now() - 60 * 86400000;
      var cleaned = {};
      Object.keys(h).forEach(function (k) { if (h[k] > cutoff) cleaned[k] = h[k]; });
      setHandled(cleaned);
      if (Object.keys(cleaned).length !== Object.keys(h).length) store.set('rengage-followup-handled', cleaned);
    })();
  }, []);

  // Keep the tab badge in sync with what's actually visible (not dismissed).
  useEffect(function () {
    var n = followUps.filter(function (f) { return !handled[f.postUrl]; }).length;
    if (onCountUpdate) onCountUpdate(n);
  }, [followUps, handled]);

  function dismiss(fu) {
    var next = Object.assign({}, handled);
    next[fu.postUrl] = Date.now();
    setHandled(next);
    store.set('rengage-followup-handled', next);
    if (expanded === fu.postUrl + fu.latestReply.author) setExpanded(null);
  }

  // Match a reply's subreddit to a campaign (for context + tagging).
  function campaignForSub(sub) {
    var s = (sub || '').toLowerCase();
    return campaigns.find(function (c) {
      return (c.subs || []).some(function (x) { return x.replace(/^r\//i, '').trim().toLowerCase() === s; });
    });
  }

  async function refresh() {
    if (!inboxUrl) {
      setFollowUps([]);
      setError('Add your Reddit inbox RSS URL in Settings to detect replies.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      var res = await fetchInboxReplies(inboxUrl);
      if (res.error) {
        setFollowUps([]);
        setError('Could not load inbox feed: ' + (res.error === 'no-url' ? 'no URL set' : res.error.slice(0, 90)));
        setLoading(false);
        return;
      }
      var userLower = (username || '').toLowerCase();
      var items = (res.items || [])
        // Don't surface your own replies as follow-ups.
        .filter(function (it) { return !userLower || it.author.toLowerCase() !== userLower; })
        .map(function (it) {
          var camp = campaignForSub(it.subreddit);
          return {
            postUrl: it.link,
            postTitle: it.title,
            subreddit: it.subreddit,
            campaign: camp ? camp.name : '',
            myComment: '',
            latestReply: { author: it.author, body: it.body, created_utc: it.created_utc },
            replyCount: 1,
            needsFollowUp: true,
            commentedAt: null,
          };
        });
      setFollowUps(items);
      setLastChecked(new Date());
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  async function handleExpand(fu) {
    var key = fu.postUrl + fu.latestReply.author;
    if (expanded === key) { setExpanded(null); return; }
    setExpanded(key);
    if (replies[key]) return;

    // Find campaign context for this follow-up
    var context = '';
    var campaign = campaigns.find(function (c) { return c.name === fu.campaign; });
    if (campaign) context = campaign.context;

    setReplyLoading(key);
    try {
      var post = {
        subreddit: fu.subreddit,
        title: fu.postTitle,
        selftext: 'My original comment: ' + fu.myComment + '\n\nTheir reply: ' + fu.latestReply.body,
      };
      var drafts = await generateReplies(post, context);
      var next = Object.assign({}, replies);
      next[key] = drafts;
      setReplies(next);
    } catch (e) {
      var next2 = Object.assign({}, replies);
      next2[key] = [{ text: 'Error: ' + e.message, approach: 'Error', recommended: true }];
      setReplies(next2);
    }
    setReplyLoading(null);
  }

  function handleReply(fu, replyText) {
    var warning = getFrequencyWarning ? getFrequencyWarning(fu.subreddit) : null;
    if (warning) {
      Alert.alert('Slow Down', warning, [
        { text: 'Reply Anyway', onPress: function () { doReply(fu, replyText); } },
        { text: 'Cancel', style: 'cancel' },
      ]);
    } else {
      doReply(fu, replyText);
    }
  }

  function doReply(fu, replyText) {
    Clipboard.setString(replyText);
    if (onLogPost) onLogPost(fu.subreddit);
    Linking.openURL(fu.postUrl);
    dismiss(fu); // you've engaged — clear it from the list
    if (onRengaged) onRengaged();
    Alert.alert('Reply Copied', 'Paste your follow-up in Reddit.');
  }

  var needsAction = followUps.filter(function (f) { return !handled[f.postUrl]; });
  var responded = [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 20, paddingBottom: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700' }}>Follow-Ups</Text>
          <TouchableOpacity
            onPress={refresh}
            disabled={loading}
            style={{
              backgroundColor: loading ? colors.card2 : colors.primary,
              paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
            }}
          >
            <Text style={{ color: loading ? colors.textMuted : '#fff', fontWeight: '600', fontSize: 13 }}>
              {loading ? 'Checking...' : 'Refresh'}
            </Text>
          </TouchableOpacity>
        </View>
        {lastChecked ? (
          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>
            Last checked: {lastChecked.toLocaleTimeString()}
          </Text>
        ) : null}
      </View>

      {error ? (
        <Text style={{ color: colors.red, fontSize: 12, paddingHorizontal: 20, marginBottom: 10 }}>{error}</Text>
      ) : null}

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ color: colors.textMuted, marginTop: 12, fontSize: 13 }}>
            Loading your inbox replies...
          </Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1, paddingHorizontal: 20 }}>

          {/* Stats */}
          {followUps.length > 0 ? (
            <View style={{ flexDirection: 'row', gap: 16, marginBottom: 12 }}>
              {needsAction.length > 0 ? (
                <Text style={{ color: colors.accent, fontSize: 12, fontWeight: '600' }}>
                  {needsAction.length} need follow-up
                </Text>
              ) : null}
              {responded.length > 0 ? (
                <Text style={{ color: colors.green, fontSize: 12 }}>
                  {responded.length} responded
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Needs Follow-Up */}
          {needsAction.length > 0 ? (
            <Text style={{ color: colors.accent, fontSize: 12, fontWeight: '600', marginBottom: 8 }}>
              Needs Follow-Up
            </Text>
          ) : null}

          {needsAction.map(function (fu, idx) {
            return renderFollowUp(fu, idx, true);
          })}

          {/* Already Responded */}
          {responded.length > 0 ? (
            <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '600', marginTop: 16, marginBottom: 8 }}>
              Responded
            </Text>
          ) : null}

          {responded.map(function (fu, idx) {
            return renderFollowUp(fu, idx, false);
          })}

          {/* Empty state */}
          {!loading && needsAction.length === 0 && !error ? (
            <View style={{ alignItems: 'center', paddingTop: 60 }}>
              <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
                No replies in your inbox feed yet.{'\n'}When someone replies to you, it'll show here.
              </Text>
            </View>
          ) : null}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </View>
  );

  function renderFollowUp(fu, idx, isActionable) {
    var key = fu.postUrl + fu.latestReply.author;
    var isOpen = expanded === key;

    return (
      <View key={key + idx} style={{
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: isActionable ? colors.accent : colors.border,
        borderRadius: 10, padding: 14, marginBottom: 8,
        opacity: isActionable ? 1 : 0.6,
      }}>
        <TouchableOpacity onPress={function () { handleExpand(fu); }} activeOpacity={0.7}>
          {/* Post title */}
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '500', lineHeight: 18 }} numberOfLines={2}>
            {fu.postTitle}
          </Text>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <Text style={{ color: colors.primary, fontSize: 11 }}>r/{fu.subreddit}</Text>
            {fu.campaign ? (
              <View style={{ backgroundColor: colors.primaryDim, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ color: colors.primary, fontSize: 10, fontWeight: '600' }}>{fu.campaign}</Text>
              </View>
            ) : null}
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>
              {fu.replyCount} {fu.replyCount === 1 ? 'reply' : 'replies'}
            </Text>
            {isActionable ? (
              <View style={{ backgroundColor: colors.accentDim, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ color: colors.accent, fontSize: 10, fontWeight: '700' }}>FOLLOW UP</Text>
              </View>
            ) : null}
          </View>

          {/* Your comment (only when known) */}
          {fu.myComment ? (
            <View style={{ backgroundColor: colors.card2, borderRadius: 6, padding: 10, marginTop: 10 }}>
              <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '600', marginBottom: 3 }}>Your comment</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 17 }} numberOfLines={3}>
                {fu.myComment}
              </Text>
            </View>
          ) : null}

          {/* Their reply */}
          <View style={{
            backgroundColor: isActionable ? colors.accentDim : colors.card2,
            borderRadius: 6, padding: 10, marginTop: 6,
            borderLeftWidth: 3, borderLeftColor: isActionable ? colors.accent : colors.border,
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '600' }}>
                u/{fu.latestReply.author}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 10 }}>
                {timeAgo(fu.latestReply.created_utc)}
              </Text>
            </View>
            <Text style={{ color: colors.text, fontSize: 12, lineHeight: 17, marginTop: 3 }} numberOfLines={isOpen ? 20 : 4}>
              {fu.latestReply.body}
            </Text>
          </View>
        </TouchableOpacity>

        {/* Reply drafts */}
        {isOpen ? (
          <View style={{ marginTop: 14 }}>
            {replyLoading === key ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <ActivityIndicator color={colors.primary} />
                <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 8 }}>Drafting follow-up...</Text>
              </View>
            ) : null}

            {replies[key] ? replies[key].map(function (r, ri) {
              var isRec = r.recommended;
              return (
                <View key={ri} style={{
                  borderWidth: 1, borderColor: isRec ? colors.green : colors.border,
                  borderRadius: 8, padding: 12, marginBottom: 8,
                  backgroundColor: isRec ? colors.greenDim : colors.inputBg,
                }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>{r.approach}</Text>
                    {isRec ? (
                      <View style={{ backgroundColor: colors.green, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3 }}>
                        <Text style={{ color: '#000', fontSize: 9, fontWeight: '700', textTransform: 'uppercase' }}>Best fit</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={{ color: colors.text, fontSize: 13, lineHeight: 19 }}>{r.text}</Text>
                  <TouchableOpacity
                    onPress={function () { handleReply(fu, r.text); }}
                    disabled={rengageActive}
                    style={{
                      marginTop: 8, padding: 10, borderRadius: 6, alignItems: 'center',
                      backgroundColor: rengageActive ? colors.card2 : (isRec ? colors.green : colors.card2),
                      opacity: rengageActive ? 0.6 : 1,
                    }}
                  >
                    <Text style={{ color: rengageActive ? colors.textMuted : (isRec ? '#000' : colors.text), fontWeight: '600', fontSize: 13 }}>
                      {rengageActive ? 'Cooldown · ' + rengageRemainingMin + 'm' : 'Rengage'}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            }) : null}

            {/* Quick open without drafting */}
            <TouchableOpacity
              onPress={function () { Linking.openURL(fu.postUrl); }}
              style={{ padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.card2 }}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Open Post in Reddit</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Dismiss — hide whether or not you follow up */}
        <TouchableOpacity
          onPress={function () { dismiss(fu); }}
          style={{ marginTop: 10, paddingVertical: 6, alignItems: 'center' }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    );
  }
}
