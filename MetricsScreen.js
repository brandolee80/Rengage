import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import DateField from './DateField';
import CorrelationChart from './CorrelationChart';

// Entries hold range totals (ASC reports cumulative-over-a-range). Normalize to
// per-day so periods of different lengths stay comparable on charts/trends.
function eEnd(e) { return e.periodEnd || e.date; }
function eStart(e) { return e.periodStart || e.date; }
function eDays(e) {
  if (e.periodStart && e.periodEnd) {
    return Math.max(1, Math.round((new Date(e.periodEnd) - new Date(e.periodStart)) / 86400000) + 1);
  }
  return 1;
}
function perDay(e, field) { return typeof e[field] === 'number' ? e[field] / eDays(e) : null; }
var DAY = 86400000;
import {
  loadActionItems, saveActionItems, buildActionItems, loadMetrics, saveMetrics,
  effortScore, effortColor, weeklySeries, newId, itemStatus, campaignColor,
  fetchKeywordRank, loadRankHistory, saveRankHistory,
} from './marketing';

export default function MetricsScreen({ colors, campaigns, commentLog, redditWeeklyTarget, generateBoost }) {
  var [boostLoading, setBoostLoading] = useState(false);
  var [suggestions, setSuggestions] = useState([]);
  var [boostError, setBoostError] = useState(null);
  var [rankHistory, setRankHistory] = useState([]);
  var [rankBusy, setRankBusy] = useState(false);
  var [rankProgress, setRankProgress] = useState('');
  var [rankError, setRankError] = useState(null);
  var [selectedId, setSelectedId] = useState(campaigns.length ? campaigns[0].id : null);
  var [items, setItems] = useState([]);
  var [entries, setEntries] = useState([]);
  var [periodStart, setPeriodStart] = useState(new Date(Date.now() - 7 * 86400000));
  var [periodEnd, setPeriodEnd] = useState(new Date(Date.now() - 86400000));
  var [platform, setPlatform] = useState('App Store');
  var [editingId, setEditingId] = useState(null);
  var [entryError, setEntryError] = useState(null);
  var [impressions, setImpressions] = useState('');
  var [downloads, setDownloads] = useState('');
  var [pageViews, setPageViews] = useState('');
  var [customLabel, setCustomLabel] = useState('');
  var [customValue, setCustomValue] = useState('');
  var [chartShow, setChartShow] = useState({ effort: true, downloads: true, pageViews: false, cvr: false });
  var [chartMode, setChartMode] = useState('rate'); // 'rate' = per-week (correlation) | 'totals' = cumulative (progress)

  useEffect(function () {
    if (!selectedId && campaigns.length) setSelectedId(campaigns[0].id);
  }, [campaigns.length]);

  useEffect(function () { if (selectedId) load(selectedId); }, [selectedId]);

  async function load(id) {
    setItems(await loadActionItems(id));
    var m = await loadMetrics(id);
    var changed = false;
    m.forEach(function (en) { if (!en.id) { en.id = newId(); changed = true; } });
    if (changed) saveMetrics(id, m);
    setEntries(m);
    // Default the next period to "since last entry -> yesterday" (ASC's latest
    // complete day) so entries tile without overlap.
    var yest = new Date(Date.now() - DAY);
    var lastEnd = m.length ? new Date(eEnd(m[m.length - 1])) : null;
    setPeriodStart(lastEnd ? new Date(lastEnd.getTime() + DAY) : new Date(yest.getTime() - 6 * DAY));
    setPeriodEnd(yest);
    setEditingId(null); setEntryError(null);
    setSuggestions([]); setBoostError(null); setRankError(null);
    var hist = await loadRankHistory(id);
    setRankHistory(hist);
    // Auto-run monthly: if a campaign has an App Store id + ASO keywords and the
    // last check is 30+ days old (or never), refresh ranks.
    var camp = campaigns.filter(function (c) { return c.id === id; })[0];
    if (camp && camp.appStoreId && (camp.asoKeywords || []).length) {
      var last = hist.length ? new Date(hist[hist.length - 1].date).getTime() : 0;
      if (Date.now() - last > 30 * 86400000) runRanks(camp, hist);
    }
  }

  async function runRanks(camp, hist) {
    camp = camp || campaigns.filter(function (c) { return c.id === selectedId; })[0];
    if (!camp || !camp.appStoreId) { setRankError('Add your App Store ID to this campaign to track ranks.'); return; }
    var kws = (camp.asoKeywords || []).slice(0, 15);
    if (!kws.length) { setRankError('Add ASO keywords to this campaign.'); return; }
    setRankBusy(true); setRankError(null);
    var ranks = {};
    for (var i = 0; i < kws.length; i++) {
      setRankProgress('Checking ' + (i + 1) + '/' + kws.length + ': ' + kws[i]);
      try { ranks[kws[i]] = await fetchKeywordRank(kws[i], camp.appStoreId); }
      catch (e) { ranks[kws[i]] = null; }
      if (i < kws.length - 1) await new Promise(function (r) { setTimeout(r, 3500); }); // ~17/min, under Apple's limit
    }
    var entry = { date: new Date().toISOString().slice(0, 10), ranks: ranks };
    var next = (hist || rankHistory).concat([entry]);
    setRankHistory(next);
    await saveRankHistory(camp.id, next);
    setRankBusy(false); setRankProgress('');
  }

  async function runBoost() {
    if (!selectedCampaign) return;
    setBoostLoading(true); setBoostError(null);
    try {
      var situation = 'Effort score ' + (score == null ? 'n/a' : score) + '. Downloads trend: ' + trend.direction + '.';
      var sugg = await generateBoost(selectedCampaign, items, situation);
      setSuggestions(sugg);
    } catch (e) {
      setBoostError(e.message.indexOf('No API key') !== -1 ? 'Add your Gemini API key in Settings.' : e.message);
    }
    setBoostLoading(false);
  }

  async function addSuggestion(s) {
    var built = buildActionItems(selectedCampaign, [s]);
    var next = items.concat(built);
    setItems(next);
    await saveActionItems(selectedId, next);
    setSuggestions(suggestions.filter(function (x) { return x !== s; }));
  }

  // Two periods of the same platform overlap if start1 <= end2 && start2 <= end1.
  function overlaps(startStr, endStr, plat, excludeId) {
    var s = new Date(startStr).getTime(), e = new Date(endStr).getTime();
    return entries.some(function (en) {
      if (en.id === excludeId) return false;
      if ((en.platform || 'App Store') !== plat) return false;
      var es = new Date(eStart(en)).getTime(), ee = new Date(eEnd(en)).getTime();
      return s <= ee && es <= e;
    });
  }

  function saveEntry() {
    setEntryError(null);
    if (periodEnd.getTime() < periodStart.getTime()) { setEntryError('End date must be on or after the start date.'); return; }
    var startStr = periodStart.toISOString().slice(0, 10);
    var endStr = periodEnd.toISOString().slice(0, 10);
    if (overlaps(startStr, endStr, platform, editingId)) {
      setEntryError('That range overlaps an existing ' + platform + ' entry. Adjust the dates so periods do not double-count.');
      return;
    }
    var entry = { id: editingId || newId(), periodStart: startStr, periodEnd: endStr, platform: platform };
    if (impressions.trim()) entry.impressions = parseInt(impressions) || 0;
    if (pageViews.trim()) entry.pageViews = parseInt(pageViews) || 0;
    if (downloads.trim()) entry.downloads = parseInt(downloads) || 0;
    if (customLabel.trim()) { entry.customLabel = customLabel.trim(); entry.customValue = customValue.trim(); }
    if (entry.impressions == null && entry.pageViews == null && entry.downloads == null && !entry.customLabel) { setEntryError('Enter at least one metric.'); return; }
    var next = editingId
      ? entries.map(function (en) { return en.id === editingId ? entry : en; })
      : entries.concat([entry]);
    next.sort(function (a, b) { return new Date(eEnd(a)) - new Date(eEnd(b)); });
    setEntries(next);
    saveMetrics(selectedId, next);
    setImpressions(''); setDownloads(''); setPageViews(''); setCustomLabel(''); setCustomValue(''); setEditingId(null);
    setPeriodStart(new Date(periodEnd.getTime() + DAY));
    setPeriodEnd(new Date(Date.now() - DAY));
  }

  function startEdit(en) {
    setEditingId(en.id); setEntryError(null);
    setPeriodStart(new Date(eStart(en)));
    setPeriodEnd(new Date(eEnd(en)));
    setPlatform(en.platform || 'App Store');
    setImpressions(en.impressions != null ? String(en.impressions) : '');
    setPageViews(en.pageViews != null ? String(en.pageViews) : '');
    setDownloads(en.downloads != null ? String(en.downloads) : '');
    setCustomLabel(en.customLabel || ''); setCustomValue(en.customValue || '');
  }

  function cancelEdit() {
    setEditingId(null); setEntryError(null);
    setImpressions(''); setPageViews(''); setDownloads(''); setCustomLabel(''); setCustomValue('');
  }

  function removeEntry(id) {
    var next = entries.filter(function (en) { return en.id !== id; });
    setEntries(next);
    saveMetrics(selectedId, next);
    if (editingId === id) cancelEdit();
  }

  var liveItems = items.filter(function (it) { return itemStatus(it) !== 'removed'; });

  // Reddit comments made for this campaign in the last 7 days.
  var selectedCampaign = campaigns.filter(function (c) { return c.id === selectedId; })[0];
  var weekAgo = Date.now() - 7 * 86400000;
  var redditCount = Object.keys(commentLog || {}).filter(function (k) {
    var c = commentLog[k];
    return c && selectedCampaign && c.campaign === selectedCampaign.name && new Date(c.at).getTime() > weekAgo;
  }).length;
  var target = redditWeeklyTarget || 5;

  var score = effortScore(liveItems, { count: redditCount, target: target });
  var completed = liveItems.filter(function (it) { return itemStatus(it) === 'completed'; }).length;
  // Per-day downloads series (normalized across different period lengths).
  var dlPoints = entries
    .map(function (e) { return { date: eEnd(e), v: perDay(e, 'downloads') }; })
    .filter(function (p) { return p.v != null; })
    .sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  var trend = (function () {
    if (dlPoints.length < 2) return { direction: 'unknown', delta: 0 };
    var last = dlPoints[dlPoints.length - 1].v, prevv = dlPoints[dlPoints.length - 2].v;
    var pct = prevv === 0 ? (last > 0 ? 1 : 0) : (last - prevv) / prevv;
    return { direction: pct > 0.05 ? 'growing' : pct < -0.05 ? 'declining' : 'flat', delta: Math.round((last - prevv) * 10) / 10 };
  })();

  // Effort + results on one weekly grid (same time scale), each normalized to its
  // own range. 'rate' = per-week activity (rises/falls → correlation); 'totals' =
  // cumulative (always climbs → progress). effortKeep keeps 0 weeks; metrics drop
  // null weeks (no data entered ≠ zero results).
  var ws = weeklySeries(liveItems, entries);
  var rate = chartMode === 'rate';
  function effPts() { return ws.map(function (p) { return { date: p.date, value: rate ? p.effortDoneWeek : p.effortCumulative }; }); }
  function metricPts(weekField, cumField) {
    return ws.map(function (p) { return { date: p.date, value: rate ? p[weekField] : p[cumField] }; })
      .filter(function (p) { return p.value != null; });
  }
  var chartSeries = [
    { key: 'effort', label: rate ? 'Effort/wk' : 'Effort total', color: colors.primary, points: effPts() },
    { key: 'downloads', label: 'Downloads', color: colors.green, points: metricPts('downloadsWeek', 'downloadsCum') },
    { key: 'pageViews', label: 'Views', color: colors.accent, points: metricPts('viewsWeek', 'viewsCum') },
    { key: 'cvr', label: 'CVR %', color: '#8B5CF6', points: metricPts('cvrWeek', 'cvrCum') },
  ];
  var visibleSeries = chartSeries.filter(function (s) { return chartShow[s.key] && s.points.length > 0; });

  if (campaigns.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
        <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center' }}>Create a campaign to track metrics.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 20, paddingBottom: 0 }}>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 12 }}>Metrics</Text>
        {campaigns.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            {campaigns.map(function (c, i) {
              var active = selectedId === c.id;
              return (
                <TouchableOpacity key={c.id} onPress={function () { setSelectedId(c.id); }}
                  style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginRight: 8, backgroundColor: active ? campaignColor(i) : colors.card2 }}>
                  <Text style={{ color: active ? '#fff' : colors.textMuted, fontSize: 12, fontWeight: '600' }}>{c.name}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      <ScrollView style={{ flex: 1, paddingHorizontal: 20 }}>
        {/* Effort score */}
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
          <View style={{ flex: 1, backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 14 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600' }}>EFFORT SCORE</Text>
            <Text style={{ color: effortColor(score, colors), fontSize: 30, fontWeight: '800', marginTop: 2 }}>{score == null ? '—' : score}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>{completed} of {liveItems.length} actions done</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 14 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600' }}>DOWNLOADS/DAY TREND</Text>
            <Text style={{ color: trend.direction === 'growing' ? colors.green : trend.direction === 'declining' ? colors.red : colors.accent, fontSize: 18, fontWeight: '700', marginTop: 6 }}>
              {trend.direction === 'growing' ? '↑ Growing' : trend.direction === 'declining' ? '↓ Declining' : trend.direction === 'flat' ? '→ Flat' : '—'}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{trend.delta ? (trend.delta > 0 ? '+' : '') + trend.delta + '/day' : 'add data'}</Text>
          </View>
        </View>

        {/* Reddit engagement (this week) */}
        <View style={{ backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600' }}>REDDIT ENGAGEMENT (THIS WEEK)</Text>
            <Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>{redditCount} / {target}</Text>
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.card2, overflow: 'hidden' }}>
            <View style={{ width: Math.min(100, Math.round((redditCount / target) * 100)) + '%', height: 6, backgroundColor: redditCount >= target ? colors.green : colors.primary }} />
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 5 }}>
            {redditCount >= target ? 'Weekly goal met — full effort credit.' : 'Each comment counts toward your weekly goal and your effort score.'}
          </Text>
        </View>

        {/* Adaptive Boost */}
        {(function () {
          var nudge = score != null && score >= 70 && (trend.direction === 'flat' || trend.direction === 'declining');
          return (
            <View style={{ backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: nudge ? colors.accent : colors.border, padding: 14, marginBottom: 12 }}>
              <Text style={{ color: nudge ? colors.accent : colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Boost Your Results</Text>
              <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10, lineHeight: 16 }}>
                {nudge
                  ? 'Your effort is high but downloads are ' + trend.direction + '. Try channels you have not used yet:'
                  : 'Get AI suggestions for untried channels and fresh angles.'}
              </Text>
              {boostError ? <Text style={{ color: colors.red, fontSize: 11, marginBottom: 8 }}>{boostError}</Text> : null}
              {suggestions.length === 0 ? (
                <TouchableOpacity onPress={runBoost} disabled={boostLoading}
                  style={{ backgroundColor: nudge ? colors.accent : colors.card2, padding: 11, borderRadius: 8, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                  {boostLoading ? <ActivityIndicator size="small" color={nudge ? '#000' : colors.text} /> : null}
                  <Text style={{ color: nudge ? '#000' : colors.text, fontWeight: '600', fontSize: 13 }}>{boostLoading ? 'Thinking...' : 'Suggest actions'}</Text>
                </TouchableOpacity>
              ) : (
                <View>
                  {suggestions.map(function (s, i) {
                    return (
                      <View key={i} style={{ backgroundColor: colors.card2, borderRadius: 8, padding: 10, marginBottom: 6 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '600' }}>{s.platform}{s.paid ? ' · $' : ''}</Text>
                          <TouchableOpacity onPress={function () { addSuggestion(s); }}>
                            <Text style={{ color: colors.green, fontSize: 12, fontWeight: '700' }}>+ Add</Text>
                          </TouchableOpacity>
                        </View>
                        <Text style={{ color: colors.text, fontSize: 13, marginTop: 2 }}>{s.title}</Text>
                        {s.rationale ? <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2, fontStyle: 'italic' }}>{s.rationale}</Text> : null}
                      </View>
                    );
                  })}
                  <TouchableOpacity onPress={function () { setSuggestions([]); }} style={{ padding: 8, alignItems: 'center' }}>
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>Dismiss</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        })()}

        {/* Effort vs results correlation */}
        <View style={{ backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600' }}>EFFORT vs RESULTS</Text>
            <View style={{ flexDirection: 'row', backgroundColor: colors.card2, borderRadius: 7, padding: 2 }}>
              {[['rate', 'Rate'], ['totals', 'Totals']].map(function (m) {
                var on = chartMode === m[0];
                return (
                  <TouchableOpacity key={m[0]} onPress={function () { setChartMode(m[0]); }}
                    style={{ paddingHorizontal: 11, paddingVertical: 4, borderRadius: 5, backgroundColor: on ? colors.primary : 'transparent' }}>
                    <Text style={{ color: on ? '#fff' : colors.textMuted, fontSize: 11, fontWeight: '600' }}>{m[1]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 10, marginBottom: 10, lineHeight: 14 }}>
            {rate
              ? 'Per week, on one weekly grid. Each line is scaled to its own range — watch whether results rise the weeks you put in work.'
              : 'Running totals — both effort and results only climb, so this shows how far you have come, not cause and effect.'}
          </Text>
          <CorrelationChart colors={colors} series={visibleSeries} height={150} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {chartSeries.map(function (s) {
              var on = chartShow[s.key];
              var has = s.points.length > 0;
              return (
                <TouchableOpacity key={s.key} disabled={!has}
                  onPress={function () { setChartShow(Object.assign({}, chartShow, (function () { var o = {}; o[s.key] = !on; return o; })())); }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, opacity: has ? 1 : 0.35, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 14, backgroundColor: on && has ? colors.card2 : 'transparent', borderWidth: 1, borderColor: on && has ? s.color : colors.border }}>
                  <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: on && has ? s.color : colors.textMuted }} />
                  <Text style={{ color: on && has ? colors.text : colors.textMuted, fontSize: 11, fontWeight: '600' }}>{s.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Keyword ranks (ASO, iOS) */}
        {(function () {
          var latest = rankHistory.length ? rankHistory[rankHistory.length - 1] : null;
          var prev = rankHistory.length > 1 ? rankHistory[rankHistory.length - 2] : null;
          var kws = (selectedCampaign && selectedCampaign.asoKeywords) || (latest ? Object.keys(latest.ranks) : []);
          var hasId = selectedCampaign && selectedCampaign.appStoreId;
          return (
            <View style={{ backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600' }}>KEYWORD RANKS (iOS)</Text>
                <TouchableOpacity onPress={function () { runRanks(); }} disabled={rankBusy || !hasId}>
                  <Text style={{ color: (rankBusy || !hasId) ? colors.textMuted : colors.primary, fontSize: 12, fontWeight: '600' }}>{rankBusy ? '...' : 'Check now'}</Text>
                </TouchableOpacity>
              </View>
              {rankError ? <Text style={{ color: colors.red, fontSize: 11, marginBottom: 6 }}>{rankError}</Text> : null}
              {rankBusy ? <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 6 }}>{rankProgress}</Text> : null}
              {!hasId ? (
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>Add an App Store ID + ASO keywords to this campaign to track search ranks.</Text>
              ) : !latest ? (
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>No checks yet. Tap "Check now" (auto-refreshes monthly).</Text>
              ) : (
                <View>
                  {kws.map(function (kw, i) {
                    var r = latest.ranks[kw];
                    var p = prev ? prev.ranks[kw] : undefined;
                    var delta = (typeof r === 'number' && typeof p === 'number') ? p - r : null; // + = improved
                    return (
                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 }}>
                        <Text style={{ color: colors.text, fontSize: 12, flex: 1 }} numberOfLines={1}>{kw}</Text>
                        <Text style={{ color: typeof r === 'number' ? colors.text : colors.textMuted, fontSize: 12, fontWeight: '600', width: 70, textAlign: 'right' }}>
                          {typeof r === 'number' ? '#' + r : '100+'}
                        </Text>
                        <Text style={{ width: 44, textAlign: 'right', fontSize: 11, color: delta == null ? colors.textMuted : delta > 0 ? colors.green : delta < 0 ? colors.red : colors.textMuted }}>
                          {delta == null ? '' : delta > 0 ? '↑' + delta : delta < 0 ? '↓' + Math.abs(delta) : '→'}
                        </Text>
                      </View>
                    );
                  })}
                  <Text style={{ color: colors.textMuted, fontSize: 10, marginTop: 6 }}>Last checked {latest.date} · lower number = higher rank</Text>
                </View>
              )}
            </View>
          );
        })()}

        {/* Add entry */}
        <View style={{ backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 12 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 2 }}>Add a metrics entry</Text>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10 }}>Enter the totals App Store Connect / Play shows for this date range.</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>From</Text>
            <DateField colors={colors} value={periodStart} maximumDate={new Date()} onChange={setPeriodStart} />
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>To</Text>
            <DateField colors={colors} value={periodEnd} maximumDate={new Date()} onChange={setPeriodEnd} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            {['App Store', 'Google Play'].map(function (p) {
              var active = platform === p;
              return (
                <TouchableOpacity key={p} onPress={function () { setPlatform(p); }}
                  style={{ flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6, backgroundColor: active ? colors.primary : colors.card2 }}>
                  <Text style={{ color: active ? '#fff' : colors.textMuted, fontSize: 12, fontWeight: '600' }}>{p}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {[
            { label: 'Impressions', value: impressions, setter: setImpressions },
            { label: 'Product page views', value: pageViews, setter: setPageViews },
            { label: 'Downloads', value: downloads, setter: setDownloads },
          ].map(function (f, i) {
            return (
              <View key={i} style={{ marginBottom: 8 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 3 }}>{f.label}</Text>
                <TextInput
                  style={{ backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 8, padding: 9, fontSize: 14, color: colors.text }}
                  value={f.value} onChangeText={f.setter} keyboardType="number-pad" autoCapitalize="none"
                />
              </View>
            );
          })}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput placeholder="Custom (e.g. Reviews)" placeholderTextColor={colors.textMuted}
              style={{ flex: 1, backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 8, padding: 9, fontSize: 13, color: colors.text }}
              value={customLabel} onChangeText={setCustomLabel} />
            <TextInput placeholder="Value" placeholderTextColor={colors.textMuted}
              style={{ width: 90, backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 8, padding: 9, fontSize: 13, color: colors.text }}
              value={customValue} onChangeText={setCustomValue} />
          </View>
          {entryError ? <Text style={{ color: colors.red, fontSize: 11, marginTop: 8 }}>{entryError}</Text> : null}
          <TouchableOpacity onPress={saveEntry} style={{ backgroundColor: colors.primary, padding: 11, borderRadius: 8, alignItems: 'center', marginTop: 10 }}>
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{editingId ? 'Save Changes' : 'Add Entry'}</Text>
          </TouchableOpacity>
          {editingId ? (
            <TouchableOpacity onPress={cancelEdit} style={{ padding: 8, alignItems: 'center' }}>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>Cancel edit</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Entries list */}
        {entries.slice().reverse().map(function (e, i) {
          var parts = [];
          if (typeof e.impressions === 'number') parts.push(e.impressions + ' impressions');
          if (typeof e.pageViews === 'number') parts.push(e.pageViews + ' views');
          if (typeof e.downloads === 'number') parts.push(e.downloads + ' downloads');
          if (typeof e.downloads === 'number' && typeof e.pageViews === 'number' && e.pageViews > 0) {
            parts.push((Math.round((e.downloads / e.pageViews) * 1000) / 10) + '% CVR');
          }
          if (e.customLabel) parts.push(e.customLabel + ': ' + e.customValue);
          return (
            <View key={e.id || i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: editingId === e.id ? colors.primaryDim : colors.card2, borderRadius: 8, padding: 10, marginBottom: 6 }}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>{eStart(e)}{eEnd(e) !== eStart(e) ? ' → ' + eEnd(e) : ''}{e.platform ? ' · ' + e.platform : ''}</Text>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>{parts.join(' · ')}</Text>
              </View>
              <TouchableOpacity onPress={function () { startEdit(e); }} style={{ padding: 4 }}>
                <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={function () { removeEntry(e.id); }} style={{ padding: 4, marginLeft: 6 }}>
                <Text style={{ color: colors.textMuted, fontSize: 13 }}>✕</Text>
              </TouchableOpacity>
            </View>
          );
        })}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}
