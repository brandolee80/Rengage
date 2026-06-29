import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Linking, TextInput, Image, Dimensions, AppState,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import Ionicons from '@expo/vector-icons/Ionicons';
import DateField from './DateField';
import {
  loadActionItems, saveActionItems, itemStatus, isDueThisWeekOrOverdue,
  nextOccurrence, campaignColor, startByDate,
} from './marketing';

var PLATFORM_HOME = {
  x: 'https://twitter.com/compose/tweet',
  twitter: 'https://twitter.com/compose/tweet',
  instagram: 'https://instagram.com',
  tiktok: 'https://tiktok.com',
  medium: 'https://medium.com/new-story',
  'product hunt': 'https://www.producthunt.com/posts/new',
  reddit: 'https://www.reddit.com/submit',
  linkedin: 'https://www.linkedin.com/feed/',
  'hacker news': 'https://news.ycombinator.com/submit',
  facebook: 'https://www.facebook.com',
};

export default function ActionsScreen({ colors, campaigns, generateActionContent, tagCampaignAssets, onUpdateCampaign }) {
  var [items, setItems] = useState([]);
  var [filter, setFilter] = useState('week');
  var [index, setIndex] = useState(0);
  var [genLoading, setGenLoading] = useState(null);
  var [error, setError] = useState(null);
  var [copied, setCopied] = useState('');
  var [completingId, setCompletingId] = useState(null);
  var [completeDate, setCompleteDate] = useState(new Date());
  var [tagging, setTagging] = useState(null);     // campaignId being analyzed
  var [captureMsg, setCaptureMsg] = useState(null); // feedback after a capture attempt
  var scrollRef = useRef(null);
  var pendingCapture = useRef(null);               // { campaignId, at } while user is away taking a shot
  var W = Dimensions.get('window').width;

  // When the user returns from taking a screenshot, pull the newest one in.
  useEffect(function () {
    var sub = AppState.addEventListener('change', function (state) {
      if (state === 'active' && pendingCapture.current) importLatestCapture();
    });
    return function () { sub.remove(); };
  }, [campaigns]);

  // Map campaignId -> color (assigned by creation order).
  var colorOf = {};
  campaigns.forEach(function (c, i) { colorOf[c.id] = campaignColor(i); });
  var campOf = {};
  campaigns.forEach(function (c) { campOf[c.id] = c; });

  useEffect(function () { loadAll(); }, [campaigns.length]);

  async function loadAll() {
    var all = [];
    for (var i = 0; i < campaigns.length; i++) {
      var its = await loadActionItems(campaigns[i].id);
      all = all.concat(its);
    }
    setItems(all);
  }

  function persist(next) {
    setItems(next);
    var byCampaign = {};
    next.forEach(function (it) {
      if (!byCampaign[it.campaignId]) byCampaign[it.campaignId] = [];
      byCampaign[it.campaignId].push(it);
    });
    Object.keys(byCampaign).forEach(function (cid) { saveActionItems(cid, byCampaign[cid]); });
  }

  function copy(key, text) {
    Clipboard.setStringAsync(text || '');
    setCopied(key);
    setTimeout(function () { setCopied(''); }, 1500);
  }

  function hasContent(c) {
    if (!c || Array.isArray(c)) return false;
    if (typeof c.body === 'string' && c.body.length) return true;
    if (typeof c.visual === 'string' && c.visual.length) return true;
    return Array.isArray(c.fields) && c.fields.length > 0;
  }

  async function generateContent(item) {
    if (hasContent(item.content) || genLoading) return;
    setGenLoading(item.id); setError(null);
    try {
      var content = await generateActionContent(campOf[item.campaignId], item);
      var next = items.map(function (it) {
        return it.id === item.id ? Object.assign({}, it, { content: content, generated: true }) : it;
      });
      persist(next);
    } catch (e) {
      setError(e.message.indexOf('No API key') !== -1 ? 'Add your Gemini API key in Settings.' : e.message);
    }
    setGenLoading(null);
  }

  function changeFilter(key) {
    setFilter(key);
    setIndex(0);
    if (scrollRef.current) scrollRef.current.scrollTo({ x: 0, animated: false });
  }

  function handleComplete(item, dateStr) {
    var d = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var iso = d.toISOString();
    var wasCompleted = !!item.completedDate;
    var next = items.map(function (it) {
      return it.id === item.id ? Object.assign({}, it, { completedDate: iso }) : it;
    });
    // Only spawn the next occurrence when completing for the first time.
    if (item.type === 'recurring' && !wasCompleted) {
      var follow = nextOccurrence(item, iso);
      if (follow) next = next.concat([follow]);
    }
    persist(next);
    setCompletingId(null);
  }

  function handleRemove(item) {
    Alert.alert('Remove this action?', 'Why are you removing it?', [
      { text: 'Not relevant', onPress: function () { markRemoved(item, 'not-relevant'); } },
      { text: "I'll do it differently", onPress: function () { markRemoved(item, 'different-way'); } },
      { text: 'Skipping it', style: 'destructive', onPress: function () { markRemoved(item, 'skipping'); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function markRemoved(item, reason) {
    var next = items.map(function (it) {
      return it.id === item.id ? Object.assign({}, it, { removed: true, removalReason: reason }) : it;
    });
    persist(next);
  }

  function openPlatform(item) {
    var url = PLATFORM_HOME[(item.platform || '').toLowerCase()];
    if (url) Linking.openURL(url);
  }

  // Download (if remote) then open the system share sheet, which includes
  // "Save Image". Local file:// assets are shared directly. Falls back to a
  // browser open if sharing is unavailable.
  async function shareImage(url) {
    try {
      var local = /^file:/i.test(url);
      var uri = url;
      if (!local) {
        var ext = /\.png(\?|$)/i.test(url) ? 'png' : 'jpg';
        var dl = await FileSystem.downloadAsync(url, FileSystem.cacheDirectory + 'shot-' + Date.now() + '.' + ext);
        uri = dl.uri;
      }
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
      else if (!local) Linking.openURL(url);
    } catch (e) {
      if (!/^file:/i.test(url)) Linking.openURL(url);
    }
  }

  async function tagNow(campaign) {
    if (tagging || !tagCampaignAssets) return;
    setTagging(campaign.id); setError(null);
    try {
      var newAssets = await tagCampaignAssets(campaign);
      if (onUpdateCampaign) onUpdateCampaign(campaign.id, { assets: newAssets });
    } catch (e) {
      setError(e.message.indexOf('No API key') !== -1 ? 'Add your Gemini API key in Settings.' : e.message);
    }
    setTagging(null);
  }

  // Step 1: mark intent + send the user off to capture. If the campaign has a
  // saved URL scheme we deep-link into their app; otherwise we just prompt.
  async function startCapture(campaign) {
    // Settle photo permission as its own step. If we have to show the system
    // dialog, do NOT start the capture session in the same tap — the dialog
    // disrupts the foreground/background timing and the first capture gets
    // missed. Have the user tap again once access is already granted.
    var perm = await MediaLibrary.getPermissionsAsync();
    if (!perm.granted) {
      if (perm.canAskAgain) {
        var req = await MediaLibrary.requestPermissionsAsync();
        if (!req.granted) { setCaptureMsg('Photo access is needed. Enable it in Settings > Rengage > Photos.'); return; }
        setCaptureMsg('Photo access granted. Tap "Capture" again to start.');
        return;
      }
      setCaptureMsg('Photo access is off. Enable it in Settings > Rengage > Photos, then try again.');
      return;
    }
    if (perm.accessPrivileges === 'limited') {
      setCaptureMsg('Photos is set to limited access, so new screenshots may not import. Set Rengage to Full Access in Settings > Photos for this to work.');
    } else {
      setCaptureMsg(null);
    }
    pendingCapture.current = { campaignId: campaign.id, at: Date.now() };
    if (campaign.appScheme) {
      Linking.openURL(campaign.appScheme).catch(function () {});
    } else {
      Alert.alert('Capture a visual', 'Open your app, then either take a screenshot (side + volume-up) or start a screen recording from Control Center. Come back to Rengage when you are done and I will import the newest one automatically.');
    }
  }

  // Step 5: on return, grab the newest photo OR video if it was created after the
  // user left, copy it into app storage, and add it to the campaign. Screen
  // recordings live in the main library (not the Screenshots album), so we query
  // both media types rather than restricting to an album.
  async function importLatestCapture() {
    var pending = pendingCapture.current;
    pendingCapture.current = null;
    if (!pending) return;
    try {
      var res = await MediaLibrary.getAssetsAsync({
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        first: 1,
      });
      var asset = res.assets && res.assets[0];
      if (!asset || asset.creationTime <= pending.at) { setCaptureMsg('No new screenshot or recording found. Try again.'); return; }
      var info = await MediaLibrary.getAssetInfoAsync(asset);
      var src = info.localUri || asset.uri;
      var isVideo = asset.mediaType === MediaLibrary.MediaType.video;
      var m = src.match(/\.(\w{2,4})(\?|$)/);
      var ext = (m && m[1]) || (isVideo ? 'mov' : 'png');
      var dest = FileSystem.documentDirectory + 'cap-' + pending.campaignId + '-' + Date.now() + '.' + ext;
      await FileSystem.copyAsync({ from: src, to: dest });
      var camp = campOf[pending.campaignId] || {};
      var a = camp.assets || {};
      var custom = (a.custom || []).concat([dest]);
      if (onUpdateCampaign) onUpdateCampaign(pending.campaignId, { assets: Object.assign({}, a, { custom: custom }) });
      setCaptureMsg((isVideo ? 'Recording' : 'Screenshot') + ' imported.');
    } catch (e) {
      setCaptureMsg('Could not import the capture.');
    }
  }

  // ── Filtering / sorting ──
  var visible = items.filter(function (it) {
    var st = itemStatus(it);
    if (st === 'removed') return false;
    if (filter === 'week') return isDueThisWeekOrOverdue(it);
    if (filter === 'incomplete') return st !== 'completed';
    if (filter === 'completed') return st === 'completed';
    return true; // all
  });
  visible.sort(function (a, b) {
    var sa = itemStatus(a), sb = itemStatus(b);
    if (sa === 'overdue' && sb !== 'overdue') return -1;
    if (sb === 'overdue' && sa !== 'overdue') return 1;
    var da = new Date(a.dueDate).setHours(0, 0, 0, 0);
    var db = new Date(b.dueDate).setHours(0, 0, 0, 0);
    if (da !== db) return da - db;
    // Same day: best bang for buck first (high impact, low effort).
    var ra = (a.impactWeight || 1) / (a.effort || 1);
    var rb = (b.impactWeight || 1) / (b.effort || 1);
    return rb - ra;
  });

  var PHASE = { 1: 'Pre-Launch', 2: 'Launch', 3: 'Post-Launch' };
  function impactColor(n) { return n >= 4 ? colors.green : n === 3 ? colors.accent : colors.textMuted; }
  function effortColorN(n) { return n >= 4 ? colors.red : n === 3 ? colors.accent : colors.green; }
  function dueLabel(it) {
    var st = itemStatus(it);
    if (st === 'completed') return 'Done ' + new Date(it.completedDate).toLocaleDateString();
    var d = new Date(it.dueDate);
    var days = Math.round((d - Date.now()) / 86400000);
    if (st === 'overdue') return 'Overdue ' + Math.abs(days) + 'd';
    if (days <= 0) return 'Due today';
    return 'Due in ' + days + 'd';
  }

  var safeIndex = Math.min(index, Math.max(0, visible.length - 1));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 20, paddingBottom: 0 }}>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 12 }}>Actions</Text>
        <View style={{ flexDirection: 'row', backgroundColor: colors.card2, borderRadius: 8, padding: 3 }}>
          {[
            { key: 'week', label: 'This Week' },
            { key: 'incomplete', label: 'To Do' },
            { key: 'completed', label: 'Done' },
            { key: 'all', label: 'All' },
          ].map(function (f) {
            var active = filter === f.key;
            return (
              <TouchableOpacity key={f.key} onPress={function () { changeFilter(f.key); }}
                style={{ flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6, backgroundColor: active ? colors.card : 'transparent' }}>
                <Text style={{ color: active ? colors.text : colors.textMuted, fontSize: 11, fontWeight: active ? '600' : '400' }}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {visible.length > 0 ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
            <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '600' }}>{safeIndex + 1} of {visible.length}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>swipe for the next one →</Text>
          </View>
        ) : null}
      </View>

      {error ? <Text style={{ color: colors.red, fontSize: 12, paddingHorizontal: 20, marginTop: 8 }}>{error}</Text> : null}

      {visible.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
            {campaigns.length === 0 ? 'Create a campaign first.' :
             filter === 'completed' ? 'Nothing completed yet.' :
             items.length === 0 ? 'No plan yet. Generate one from the Campaigns tab.' :
             filter === 'week' ? 'Nothing due this week. Nice work.' : 'No actions.'}
          </Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={function (e) { setIndex(Math.round(e.nativeEvent.contentOffset.x / W)); }}
          style={{ flex: 1, marginTop: 12 }}
        >
          {visible.map(function (item) {
            var st = itemStatus(item);
            var color = colorOf[item.campaignId] || colors.primary;
            var camp = campOf[item.campaignId] || {};
            var aset = camp.assets || {};
            var galleryShots = (aset.iphone || []).concat(aset.ipad || []);
            var customShots = aset.custom || [];
            var assetTags = aset.tags || {};
            var untagged = (aset.iphone || []).length > 0 && Object.keys(assetTags).length < (aset.iphone || []).length;
            // Float the AI-recommended gallery image to the front and badge it.
            var recIdx = item.content && item.content.imageIndex;
            var taggedList = Object.keys(assetTags);
            var recUrl = (recIdx && taggedList[recIdx - 1]) || null;
            var orderedGallery = recUrl ? [recUrl].concat(galleryShots.filter(function (u) { return u !== recUrl; })) : galleryShots;
            var done = hasContent(item.content);
            return (
              <View key={item.id} style={{ width: W }}>
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 70 }} showsVerticalScrollIndicator={false}>
                  <View style={{
                    backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border,
                    borderTopWidth: 4, borderTopColor: color, padding: 20, opacity: st === 'completed' ? 0.6 : 1,
                  }}>
                    {/* Tags */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
                      <View style={{ backgroundColor: color, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 2 }}>
                        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{item.campaignName}</Text>
                      </View>
                      {item.phase ? <Text style={{ color: colors.textSecondary, fontSize: 11, fontWeight: '600' }}>{PHASE[item.phase]}</Text> : null}
                      {item.type === 'recurring' ? <Text style={{ color: colors.textMuted, fontSize: 11 }}>↻ every {item.recurrenceInterval}d</Text> : null}
                    </View>

                    {/* Title */}
                    <Text style={{ color: colors.text, fontSize: 23, fontWeight: '700', lineHeight: 30 }}>{item.title}</Text>

                    {/* Platform + due */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 12 }}>
                      <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '600' }}>{item.platform}</Text>
                      <Text style={{ color: st === 'overdue' ? colors.red : colors.textMuted, fontSize: 14 }}>{dueLabel(item)}</Text>
                    </View>
                    {st !== 'completed' && startByDate(item) ? (
                      <Text style={{ color: colors.accent, fontSize: 13, marginTop: 8 }}>Start by {startByDate(item).toLocaleDateString()} (needs prep)</Text>
                    ) : null}

                    {/* Stats: big decision tiles while choosing; compact strip once you commit */}
                    {done ? (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 14 }}>
                        <Text style={{ color: colors.textMuted, fontSize: 12 }}>Impact <Text style={{ color: impactColor(item.impactWeight || 3), fontWeight: '800' }}>{item.impactWeight || 3}</Text></Text>
                        <Text style={{ color: colors.textMuted, fontSize: 12 }}>Effort <Text style={{ color: effortColorN(item.effort || 3), fontWeight: '800' }}>{item.effort || 3}</Text></Text>
                        <Text style={{ color: item.paid ? colors.accent : colors.textMuted, fontSize: 12, fontWeight: '700' }}>{item.paid ? 'Paid' : 'Free'}</Text>
                      </View>
                    ) : (
                      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                        <View style={{ flex: 1, backgroundColor: colors.card2, borderRadius: 10, paddingVertical: 12, alignItems: 'center' }}>
                          <Text style={{ color: impactColor(item.impactWeight || 3), fontSize: 28, fontWeight: '800' }}>{item.impactWeight || 3}</Text>
                          <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 2 }}>IMPACT</Text>
                        </View>
                        <View style={{ flex: 1, backgroundColor: colors.card2, borderRadius: 10, paddingVertical: 12, alignItems: 'center' }}>
                          <Text style={{ color: effortColorN(item.effort || 3), fontSize: 28, fontWeight: '800' }}>{item.effort || 3}</Text>
                          <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 2 }}>EFFORT</Text>
                        </View>
                        <View style={{ flex: 1, backgroundColor: colors.card2, borderRadius: 10, paddingVertical: 12, alignItems: 'center' }}>
                          <Text style={{ color: item.paid ? colors.accent : colors.textMuted, fontSize: 28, fontWeight: '800' }}>{item.paid ? '$' : 'Free'}</Text>
                          <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 2 }}>COST</Text>
                        </View>
                      </View>
                    )}

                    {/* Rationale */}
                    {item.rationale ? (
                      <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 19, fontStyle: 'italic', marginTop: 18 }}>{item.rationale}</Text>
                    ) : null}

                    {/* Content */}
                    <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 18 }} />
                    {genLoading === item.id ? (
                      <View style={{ padding: 16, alignItems: 'center' }}>
                        <ActivityIndicator color={colors.primary} />
                        <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>Writing your {item.platform} content...</Text>
                      </View>
                    ) : hasContent(item.content) ? (
                      <View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>1</Text></View>
                          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>Your post</Text>
                        </View>
                        {item.content.body ? (
                          <View style={{ marginBottom: 12 }}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '700' }}>POST</Text>
                              <TouchableOpacity onPress={function () { copy(item.id + 'body', item.content.body); }}>
                                <Text style={{ color: copied === item.id + 'body' ? colors.green : colors.primary, fontSize: 12, fontWeight: '600' }}>{copied === item.id + 'body' ? 'Copied!' : 'Copy'}</Text>
                              </TouchableOpacity>
                            </View>
                            <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}>{item.content.body}</Text>
                          </View>
                        ) : null}
                        {(item.content.fields || []).map(function (f, fi) {
                          return (
                            <View key={fi} style={{ marginBottom: 10, backgroundColor: colors.card2, borderRadius: 8, padding: 12 }}>
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '700' }}>{(f.label || '').toUpperCase()}</Text>
                                <TouchableOpacity onPress={function () { copy(item.id + fi, f.value); }}>
                                  <Text style={{ color: copied === item.id + fi ? colors.green : colors.primary, fontSize: 12, fontWeight: '600' }}>{copied === item.id + fi ? 'Copied!' : 'Copy'}</Text>
                                </TouchableOpacity>
                              </View>
                              <Text style={{ color: colors.textSecondary, fontSize: 14, lineHeight: 20 }}>{f.value}</Text>
                            </View>
                          );
                        })}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, marginTop: 6 }}>
                          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>2</Text></View>
                          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>Your visual</Text>
                          {untagged ? (
                            <TouchableOpacity onPress={function () { tagNow(camp); }} disabled={tagging === camp.id} style={{ marginLeft: 'auto' }}>
                              <Text style={{ color: tagging === camp.id ? colors.textMuted : colors.primary, fontSize: 11, fontWeight: '600' }}>{tagging === camp.id ? 'Analyzing...' : 'Analyze images'}</Text>
                            </TouchableOpacity>
                          ) : null}
                        </View>
                        {item.content.visual ? (
                          <View style={{ backgroundColor: colors.card2, borderLeftWidth: 3, borderLeftColor: colors.accent, borderRadius: 8, padding: 12, marginBottom: 10 }}>
                            <Text style={{ color: colors.accent, fontSize: 10, fontWeight: '700', marginBottom: 4 }}>WHAT TO USE</Text>
                            <Text style={{ color: colors.textSecondary, fontSize: 14, lineHeight: 20 }}>{item.content.visual}</Text>
                          </View>
                        ) : null}
                        <View style={{ marginBottom: 10 }}>
                          {orderedGallery.length || customShots.length ? (
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                              {orderedGallery.map(function (url, si) {
                                var t = assetTags[url];
                                var isRec = url === recUrl;
                                return (
                                  <TouchableOpacity key={'g' + si} onPress={function () { shareImage(url); }} style={{ marginRight: 10, width: 92 }}>
                                    <View>
                                      <Image source={{ uri: url }} style={{ width: 92, height: 163, borderRadius: 10, backgroundColor: colors.card2, borderWidth: isRec ? 2 : 0, borderColor: colors.accent }} resizeMode="cover" />
                                      {isRec ? (<View style={{ position: 'absolute', top: 6, left: 6, backgroundColor: colors.accent, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}><Text style={{ color: '#000', fontSize: 8, fontWeight: '800' }}>PICK</Text></View>) : null}
                                    </View>
                                    {isRec ? <Text numberOfLines={2} style={{ color: colors.accent, fontSize: 9, marginTop: 3, fontWeight: '600' }}>{t && t.headline ? t.headline : 'Recommended'}</Text> : (t && t.headline ? <Text numberOfLines={2} style={{ color: colors.textMuted, fontSize: 9, marginTop: 3 }}>{t.headline}</Text> : null)}
                                  </TouchableOpacity>
                                );
                              })}
                              {customShots.map(function (url, si) {
                                var isVid = /\.(mov|mp4|m4v)(\?|$)/i.test(url);
                                return (
                                  <TouchableOpacity key={'c' + si} onPress={function () { shareImage(url); }} style={{ marginRight: 10, width: 92 }}>
                                    {isVid ? (
                                      <View style={{ width: 92, height: 163, borderRadius: 10, backgroundColor: colors.card2, borderWidth: 1, borderColor: colors.green, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name="play-circle" size={34} color={colors.green} />
                                      </View>
                                    ) : (
                                      <Image source={{ uri: url }} style={{ width: 92, height: 163, borderRadius: 10, backgroundColor: colors.card2, borderWidth: 1, borderColor: colors.green }} resizeMode="cover" />
                                    )}
                                    <Text style={{ color: colors.green, fontSize: 9, marginTop: 3 }}>{isVid ? 'Recording' : 'Captured'}</Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </ScrollView>
                          ) : null}
                          <TouchableOpacity onPress={function () { startCapture(camp); }}
                            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10, borderRadius: 8, backgroundColor: colors.card2 }}>
                            <Ionicons name="camera-outline" size={16} color={colors.textSecondary} />
                            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Capture a screenshot or recording</Text>
                          </TouchableOpacity>
                          {captureMsg ? <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 6, textAlign: 'center' }}>{captureMsg}</Text> : null}
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, marginTop: 6 }}>
                          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>3</Text></View>
                          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>Publish</Text>
                        </View>
                        {PLATFORM_HOME[(item.platform || '').toLowerCase()] ? (
                          <TouchableOpacity onPress={function () { openPlatform(item); }}
                            style={{ padding: 12, borderRadius: 8, alignItems: 'center', backgroundColor: colors.card2, marginTop: 2 }}>
                            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Open {item.platform} and paste</Text>
                          </TouchableOpacity>
                        ) : (
                          <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 19 }}>Post it on {item.platform} when you are ready, then mark it complete below.</Text>
                        )}
                      </View>
                    ) : (
                      <TouchableOpacity onPress={function () { generateContent(item); }}
                        style={{ padding: 14, borderRadius: 10, alignItems: 'center', backgroundColor: colors.primary }}>
                        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Write my content + show images</Text>
                      </TouchableOpacity>
                    )}

                    {/* Complete / Remove */}
                    {completingId === item.id ? (
                      <View style={{ marginTop: 16 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                          <Text style={{ color: colors.textMuted, fontSize: 13 }}>Completed on:</Text>
                          <DateField colors={colors} value={completeDate} maximumDate={new Date()} onChange={setCompleteDate} />
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <TouchableOpacity onPress={function () { setCompletingId(null); }}
                            style={{ flex: 1, padding: 12, borderRadius: 8, alignItems: 'center', backgroundColor: colors.card2 }}>
                            <Text style={{ color: colors.textMuted, fontSize: 14 }}>Cancel</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={function () { handleComplete(item, completeDate.toISOString()); }}
                            style={{ flex: 1, padding: 12, borderRadius: 8, alignItems: 'center', backgroundColor: colors.green }}>
                            <Text style={{ color: '#000', fontWeight: '600', fontSize: 14 }}>Confirm</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
                        {st !== 'completed' ? (
                          <TouchableOpacity onPress={function () { setCompleteDate(new Date()); setCompletingId(item.id); }}
                            style={{ flex: 1, padding: 12, borderRadius: 8, alignItems: 'center', backgroundColor: colors.green }}>
                            <Text style={{ color: '#000', fontWeight: '600', fontSize: 14 }}>Mark Complete</Text>
                          </TouchableOpacity>
                        ) : (
                          <TouchableOpacity onPress={function () { setCompleteDate(item.completedDate ? new Date(item.completedDate) : new Date()); setCompletingId(item.id); }}
                            style={{ flex: 1, padding: 12, borderRadius: 8, alignItems: 'center', backgroundColor: colors.card2 }}>
                            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Edit Date</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity onPress={function () { handleRemove(item); }}
                          style={{ paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, alignItems: 'center', backgroundColor: colors.card2 }}>
                          <Text style={{ color: colors.textMuted, fontSize: 14 }}>Remove</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                </ScrollView>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}
