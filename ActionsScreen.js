import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Linking, TextInput,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
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

export default function ActionsScreen({ colors, campaigns, generateActionContent }) {
  var [items, setItems] = useState([]);
  var [filter, setFilter] = useState('week');
  var [expanded, setExpanded] = useState(null);
  var [genLoading, setGenLoading] = useState(null);
  var [error, setError] = useState(null);
  var [copied, setCopied] = useState('');
  var [completingId, setCompletingId] = useState(null);
  var [completeDate, setCompleteDate] = useState(new Date());

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
    return Array.isArray(c.fields) && c.fields.length > 0;
  }

  async function handleExpand(item) {
    if (expanded === item.id) { setExpanded(null); return; }
    setExpanded(item.id);
    if (hasContent(item.content)) return;
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
    if (expanded === item.id) setExpanded(null);
  }

  function openPlatform(item) {
    var url = PLATFORM_HOME[(item.platform || '').toLowerCase()];
    if (url) Linking.openURL(url);
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 20, paddingBottom: 0 }}>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 12 }}>Actions</Text>
        <View style={{ flexDirection: 'row', backgroundColor: colors.card2, borderRadius: 8, padding: 3, marginBottom: 12 }}>
          {[
            { key: 'week', label: 'This Week' },
            { key: 'incomplete', label: 'To Do' },
            { key: 'completed', label: 'Done' },
            { key: 'all', label: 'All' },
          ].map(function (f) {
            var active = filter === f.key;
            return (
              <TouchableOpacity key={f.key} onPress={function () { setFilter(f.key); }}
                style={{ flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6, backgroundColor: active ? colors.card : 'transparent' }}>
                <Text style={{ color: active ? colors.text : colors.textMuted, fontSize: 11, fontWeight: active ? '600' : '400' }}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {error ? <Text style={{ color: colors.red, fontSize: 12, paddingHorizontal: 20, marginBottom: 6 }}>{error}</Text> : null}

      <ScrollView style={{ flex: 1, paddingHorizontal: 20 }}>
        {visible.map(function (item) {
          var st = itemStatus(item);
          var isOpen = expanded === item.id;
          var color = colorOf[item.campaignId] || colors.primary;
          return (
            <View key={item.id} style={{
              backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
              borderLeftWidth: 4, borderLeftColor: color, marginBottom: 8, overflow: 'hidden',
              opacity: st === 'completed' ? 0.55 : 1,
            }}>
              <TouchableOpacity onPress={function () { handleExpand(item); }} activeOpacity={0.7} style={{ padding: 14 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500', flex: 1, lineHeight: 19 }}>{item.title}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {item.paid ? <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '800' }}>$</Text> : null}
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ color: impactColor(item.impactWeight || 3), fontSize: 13, fontWeight: '800' }}>{item.impactWeight || 3}</Text>
                      <Text style={{ color: colors.textMuted, fontSize: 7 }}>IMP</Text>
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ color: effortColorN(item.effort || 3), fontSize: 13, fontWeight: '800' }}>{item.effort || 3}</Text>
                      <Text style={{ color: colors.textMuted, fontSize: 7 }}>EFF</Text>
                    </View>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, alignItems: 'center' }}>
                  <View style={{ backgroundColor: color, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
                    <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{item.campaignName}</Text>
                  </View>
                  {item.phase ? <Text style={{ color: colors.textSecondary, fontSize: 10, fontWeight: '600' }}>{PHASE[item.phase]}</Text> : null}
                  <Text style={{ color: colors.primary, fontSize: 11 }}>{item.platform}</Text>
                  <Text style={{ color: st === 'overdue' ? colors.red : colors.textMuted, fontSize: 11 }}>{dueLabel(item)}</Text>
                  {item.type === 'recurring' ? <Text style={{ color: colors.textMuted, fontSize: 11 }}>↻ every {item.recurrenceInterval}d</Text> : null}
                </View>
                {st !== 'completed' && startByDate(item) ? (
                  <Text style={{ color: colors.accent, fontSize: 11, marginTop: 5 }}>Start by {startByDate(item).toLocaleDateString()} (needs prep)</Text>
                ) : null}
                {item.rationale && !isOpen ? <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 5, fontStyle: 'italic' }}>{item.rationale}</Text> : null}
              </TouchableOpacity>

              {isOpen ? (
                <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>
                  {genLoading === item.id ? (
                    <View style={{ padding: 16, alignItems: 'center' }}>
                      <ActivityIndicator color={colors.primary} />
                      <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>Writing your {item.platform} content...</Text>
                    </View>
                  ) : item.content ? (
                    <View>
                      {item.content.body ? (
                        <View style={{ marginBottom: 10 }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '700' }}>POST</Text>
                            <TouchableOpacity onPress={function () { copy(item.id + 'body', item.content.body); }}>
                              <Text style={{ color: copied === item.id + 'body' ? colors.green : colors.primary, fontSize: 11, fontWeight: '600' }}>{copied === item.id + 'body' ? 'Copied!' : 'Copy'}</Text>
                            </TouchableOpacity>
                          </View>
                          <Text style={{ color: colors.text, fontSize: 13, lineHeight: 19 }}>{item.content.body}</Text>
                        </View>
                      ) : null}
                      {(item.content.fields || []).map(function (f, fi) {
                        return (
                          <View key={fi} style={{ marginBottom: 8, backgroundColor: colors.card2, borderRadius: 6, padding: 8 }}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                              <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '700' }}>{(f.label || '').toUpperCase()}</Text>
                              <TouchableOpacity onPress={function () { copy(item.id + fi, f.value); }}>
                                <Text style={{ color: copied === item.id + fi ? colors.green : colors.primary, fontSize: 11, fontWeight: '600' }}>{copied === item.id + fi ? 'Copied!' : 'Copy'}</Text>
                              </TouchableOpacity>
                            </View>
                            <Text style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 17 }}>{f.value}</Text>
                          </View>
                        );
                      })}
                      {PLATFORM_HOME[(item.platform || '').toLowerCase()] ? (
                        <TouchableOpacity onPress={function () { openPlatform(item); }}
                          style={{ padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.card2, marginTop: 4 }}>
                          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Open {item.platform}</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ) : null}

                  {completingId === item.id ? (
                    <View style={{ marginTop: 10 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <Text style={{ color: colors.textMuted, fontSize: 12 }}>Completed on:</Text>
                        <DateField colors={colors} value={completeDate} maximumDate={new Date()} onChange={setCompleteDate} />
                      </View>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <TouchableOpacity onPress={function () { setCompletingId(null); }}
                          style={{ flex: 1, padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.card2 }}>
                          <Text style={{ color: colors.textMuted, fontSize: 13 }}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={function () { handleComplete(item, completeDate.toISOString()); }}
                          style={{ flex: 1, padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.green }}>
                          <Text style={{ color: '#000', fontWeight: '600', fontSize: 13 }}>Confirm</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                      {st !== 'completed' ? (
                        <TouchableOpacity onPress={function () { setCompleteDate(new Date()); setCompletingId(item.id); }}
                          style={{ flex: 1, padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.green }}>
                          <Text style={{ color: '#000', fontWeight: '600', fontSize: 13 }}>Mark Complete</Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity onPress={function () { setCompleteDate(item.completedDate ? new Date(item.completedDate) : new Date()); setCompletingId(item.id); }}
                          style={{ flex: 1, padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.card2 }}>
                          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Edit Date</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={function () { handleRemove(item); }}
                        style={{ padding: 10, borderRadius: 6, alignItems: 'center', backgroundColor: colors.card2 }}>
                        <Text style={{ color: colors.textMuted, fontSize: 13 }}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              ) : null}
            </View>
          );
        })}

        {visible.length === 0 ? (
          <View style={{ alignItems: 'center', paddingTop: 50 }}>
            <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
              {campaigns.length === 0 ? 'Create a campaign first.' :
               filter === 'completed' ? 'Nothing completed yet.' :
               items.length === 0 ? 'No plan yet. Generate one from the Campaigns tab.' :
               filter === 'week' ? 'Nothing due this week.' : 'No actions.'}
            </Text>
          </View>
        ) : null}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}
