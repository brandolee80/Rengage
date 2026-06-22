import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  ActivityIndicator, Linking, Alert, Clipboard,
} from 'react-native';
import { timeAgo } from './scoring';

export default function FollowUpsScreen({
  colors, commentLog, username, checkFollowUps,
  generateReplies, campaigns, onLogPost, getFrequencyWarning,
  onCountUpdate,
}) {
  var [followUps, setFollowUps] = useState([]);
  var [loading, setLoading] = useState(false);
  var [error, setError] = useState(null);
  var [expanded, setExpanded] = useState(null);
  var [replies, setReplies] = useState({});
  var [replyLoading, setReplyLoading] = useState(null);
  var [lastChecked, setLastChecked] = useState(null);

  useEffect(function () {
    refresh();
  }, []);

  async function refresh() {
    if (!username) {
      setError('Set your Reddit username in Settings first');
      return;
    }
    var commentCount = Object.keys(commentLog).length;
    if (commentCount === 0) {
      setError('No commented posts to check yet. Start engaging first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      var results = await checkFollowUps(commentLog, username);
      setFollowUps(results);
      setLastChecked(new Date());
      var actionable = results.filter(function (f) { return f.needsFollowUp; }).length;
      if (onCountUpdate) onCountUpdate(actionable);
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
    Alert.alert('Reply Copied', 'Paste your follow-up in Reddit.');
  }

  var needsAction = followUps.filter(function (f) { return f.needsFollowUp; });
  var responded = followUps.filter(function (f) { return !f.needsFollowUp; });

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
            Checking {Object.keys(commentLog).length} posts for replies...
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
          {!loading && followUps.length === 0 && !error ? (
            <View style={{ alignItems: 'center', paddingTop: 60 }}>
              <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
                No replies to your comments yet.{'\n'}Keep engaging and check back later.
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

          {/* Your comment */}
          <View style={{ backgroundColor: colors.card2, borderRadius: 6, padding: 10, marginTop: 10 }}>
            <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '600', marginBottom: 3 }}>Your comment</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 17 }} numberOfLines={3}>
              {fu.myComment}
            </Text>
          </View>

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

            {/* Quick open without drafting */}
            <TouchableOpacity
              onPress={function () { Linking.openURL(fu.postUrl); }}
              style={{ padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.card2 }}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Open Post in Reddit</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
  }
}
