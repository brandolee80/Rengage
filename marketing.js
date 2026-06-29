// Marketing module — data model, storage, and local (non-AI) logic for the
// marketing action-plan feature. AI decides strategy + content elsewhere; this
// file is pure plumbing: ids, dates, scoring math, persistence.

import store from './store';

// ── IDs ──
export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── App Store listing import (free iTunes Lookup API; iOS only) ──
export function parseAppStoreId(url) {
  if (!url) return '';
  var m = url.match(/\/id(\d{4,})/i) || url.match(/[?&]id=(\d{4,})/i);
  if (m) return m[1];
  var bare = url.match(/(\d{6,})/);
  return bare ? bare[1] : '';
}

export function isPlayLink(url) {
  return /play\.google\.com/i.test(url || '');
}

// Returns { appStoreId, name, description, genre, rating, ratingCount, price, seller, url }.
export async function fetchAppStoreListing(url) {
  var id = parseAppStoreId(url);
  if (!id) throw new Error('Could not find an App Store id in that link.');
  var res = await fetch('https://itunes.apple.com/lookup?id=' + id);
  if (!res.ok) throw new Error('App Store lookup failed (' + res.status + ').');
  var data = await res.json();
  if (!data.results || data.results.length === 0) throw new Error('No app found for that link.');
  var a = data.results[0];
  return {
    appStoreId: id,
    name: a.trackName || '',
    description: a.description || '',
    genre: (a.genres || []).join(', '),
    rating: a.averageUserRating || null,
    ratingCount: a.userRatingCount || null,
    price: a.formattedPrice || '',
    seller: a.sellerName || '',
    url: a.trackViewUrl || url,
  };
}

// ── Campaign colors (assigned by creation order) ──
export var CAMPAIGN_COLORS = [
  '#E5453C', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#84CC16',
];

export function campaignColor(index) {
  return CAMPAIGN_COLORS[index % CAMPAIGN_COLORS.length];
}

// ── Action item shape (for reference) ──
// {
//   id, campaignId, campaignName, platform, type: 'one-time'|'recurring',
//   title,
//   content: { body, fields: [{label, value}] } | null,  // null until generated (lazy)
//   generated: bool,
//   dueDate: ISO, dueTime: string|null,
//   completedDate: ISO|null,
//   recurrenceInterval: number(days)|null,
//   impactWeight: 1-5,
//   removed: bool, removalReason: 'not-relevant'|'different-way'|'skipping'|null,
// }

var DAY_MS = 86400000;

// Turn an AI plan skeleton into full action-item objects (content stays null —
// it's generated lazily when the user opens the item).
export function buildActionItems(campaign, skeleton) {
  var now = Date.now();
  return (skeleton || []).filter(function (s) { return s && s.platform && s.title; }).map(function (s) {
    var dueInDays = typeof s.dueInDays === 'number' ? s.dueInDays : 3;
    var recurring = s.type === 'recurring';
    return {
      id: newId(),
      campaignId: campaign.id,
      campaignName: campaign.name,
      platform: s.platform,
      type: recurring ? 'recurring' : 'one-time',
      phase: (s.phase === 2 || s.phase === 3) ? s.phase : 1,
      title: s.title,
      rationale: s.rationale || '',
      content: null,
      generated: false,
      dueDate: new Date(now + dueInDays * DAY_MS).toISOString(),
      dueTime: null,
      leadTimeDays: typeof s.leadTimeDays === 'number' ? Math.max(0, s.leadTimeDays) : 0,
      completedDate: null,
      recurrenceInterval: recurring ? (s.recurrenceInterval || 7) : null,
      impactWeight: Math.max(1, Math.min(5, s.impactWeight || 3)),
      effort: Math.max(1, Math.min(5, s.effort || 3)),
      paid: !!s.paid,
      removed: false,
      removalReason: null,
    };
  });
}

function startOfDay(d) {
  var x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Derived status — never stored, always computed against "now".
export function itemStatus(item, now) {
  now = now || Date.now();
  if (item.removed) return item.removalReason === 'skipping' ? 'skipped' : 'removed';
  if (item.completedDate) return 'completed';
  if (item.dueDate && startOfDay(item.dueDate).getTime() < startOfDay(now).getTime()) return 'overdue';
  return 'pending';
}

function completedOnTime(item) {
  if (!item.completedDate || !item.dueDate) return true;
  return startOfDay(item.completedDate).getTime() <= startOfDay(item.dueDate).getTime();
}

// ── Effort score (0-100), impact-weighted with a timeliness multiplier ──
// numerator   = sum of completed weight * (1.0 on time, 0.5 late)
// denominator = sum of weight for items that count: completed, pending, overdue, skipped
//               (items removed as not-relevant / different-way are excluded entirely)
// `reddit` (optional) folds ongoing Reddit engagement in as a recurring stream:
// { count: comments this week, target: weekly goal, weight: impact (default 4) }.
// Its completion ratio = min(1, count/target), so each comment is worth 1/target.
export function effortScore(items, reddit) {
  var num = 0;
  var den = 0;
  items.forEach(function (it) {
    var st = itemStatus(it);
    if (st === 'removed') return; // not-relevant / different-way: excluded both sides
    var w = it.impactWeight || 1;
    if (st === 'completed') {
      num += w * (completedOnTime(it) ? 1.0 : 0.5);
      den += w;
    } else if (st === 'skipped' || st === 'pending' || st === 'overdue') {
      den += w; // counts against you, contributes nothing
    }
  });
  if (reddit && reddit.target > 0) {
    var rw = reddit.weight || 4;
    num += rw * Math.min(1, (reddit.count || 0) / reddit.target);
    den += rw;
  }
  if (den === 0) return null;
  return Math.round((num / den) * 100);
}

export function effortColor(score, colors) {
  if (score == null) return colors.textMuted;
  if (score >= 70) return colors.green;
  if (score >= 40) return colors.accent;
  return colors.red;
}

// ── Effort + results on one weekly grid (reconstructed from stored dates) ──
// No snapshots needed: action items carry due/completed dates + weight, and
// metric entries carry their range totals, so we can replay both onto the same
// weekly buckets — the only way effort and results are time-scale comparable.
// Each week reports two framings so the chart can switch between them:
//   RATE   (effortDoneWeek, downloadsWeek, viewsWeek, cvrWeek) — activity *in*
//          that week. Can rise and fall, so it reveals cause/effect.
//   TOTALS (effortCumulative, downloadsCum, viewsCum, cvrCum) — running totals.
//          Always climb, so they show progress, not correlation.
function mStart(e) { return e.periodStart || e.date; }
function mEnd(e) { return e.periodEnd || e.date; }
function mDays(e) {
  if (e.periodStart && e.periodEnd) return Math.max(1, Math.round((new Date(e.periodEnd) - new Date(e.periodStart)) / DAY_MS) + 1);
  return 1;
}
function mPerDay(e, field) { return typeof e[field] === 'number' ? e[field] / mDays(e) : null; }
// Whole days of an entry's [start,end] range that fall inside [wStart, wEnd).
function overlapDays(eStartStr, eEndStr, wStartMs, wEndMs) {
  var es = startOfDay(eStartStr).getTime();
  var ee = startOfDay(eEndStr).getTime() + DAY_MS; // entry covers through its end day
  var lo = Math.max(es, wStartMs);
  var hi = Math.min(ee, wEndMs);
  if (hi <= lo) return 0;
  return Math.round((hi - lo) / DAY_MS);
}

export function weeklySeries(items, entries) {
  var live = (items || []).filter(function (it) { return itemStatus(it) !== 'removed' && it.dueDate; });
  entries = entries || [];
  var times = [];
  live.forEach(function (it) {
    times.push(new Date(it.dueDate).getTime());
    if (it.completedDate) times.push(new Date(it.completedDate).getTime());
  });
  entries.forEach(function (e) {
    times.push(new Date(mStart(e)).getTime());
    times.push(new Date(mEnd(e)).getTime());
  });
  if (times.length === 0) return [];
  var WEEK = 7 * DAY_MS;
  var start = startOfDay(Math.min.apply(null, times)).getTime();
  var now = Date.now();
  var totalWeight = live.reduce(function (s, it) { return s + (it.impactWeight || 1); }, 0) || 1;
  var cumDl = 0, cumPv = 0, anyDl = false, anyPv = false;
  var out = [];
  for (var weekEnd = start + WEEK; weekEnd <= now + WEEK; weekEnd += WEEK) {
    var weekStart = weekEnd - WEEK;
    var cumWork = 0, doneWeek = 0;
    live.forEach(function (it) {
      var w = it.impactWeight || 1;
      var comp = it.completedDate ? new Date(it.completedDate).getTime() : null;
      if (comp == null) return;
      var credit = w * (completedOnTime(it) ? 1.0 : 0.5);
      if (comp <= weekEnd) cumWork += credit;
      if (comp >= weekStart && comp < weekEnd) doneWeek += credit;
    });
    var wDl = 0, wPv = 0, hasDl = false, hasPv = false;
    entries.forEach(function (e) {
      var ov = overlapDays(mStart(e), mEnd(e), weekStart, weekEnd);
      if (ov <= 0) return;
      var d = mPerDay(e, 'downloads'); if (d != null) { wDl += d * ov; hasDl = true; }
      var p = mPerDay(e, 'pageViews'); if (p != null) { wPv += p * ov; hasPv = true; }
    });
    if (hasDl) { cumDl += wDl; anyDl = true; }
    if (hasPv) { cumPv += wPv; anyPv = true; }
    out.push({
      date: new Date(Math.min(weekEnd, now)).toISOString().slice(0, 10),
      effortDoneWeek: Math.round(doneWeek * 10) / 10,
      effortCumulative: Math.round((cumWork / totalWeight) * 100),
      downloadsWeek: hasDl ? Math.round(wDl * 10) / 10 : null,
      viewsWeek: hasPv ? Math.round(wPv * 10) / 10 : null,
      cvrWeek: (hasDl && hasPv && wPv > 0) ? Math.round((wDl / wPv) * 1000) / 10 : null,
      downloadsCum: anyDl ? Math.round(cumDl) : null,
      viewsCum: anyPv ? Math.round(cumPv) : null,
      cvrCum: (anyDl && anyPv && cumPv > 0) ? Math.round((cumDl / cumPv) * 1000) / 10 : null,
    });
  }
  return out;
}

// ── Recurrence: next occurrence after completing a recurring item ──
export function nextOccurrence(item, completedDate) {
  if (item.type !== 'recurring' || !item.recurrenceInterval) return null;
  var base = completedDate ? new Date(completedDate) : new Date();
  var due = new Date(base.getTime() + item.recurrenceInterval * DAY_MS);
  return {
    id: newId(),
    campaignId: item.campaignId,
    campaignName: item.campaignName,
    platform: item.platform,
    type: 'recurring',
    title: item.title,
    content: null,          // generated fresh on demand, not copied
    generated: false,
    dueDate: due.toISOString(),
    dueTime: item.dueTime || null,
    completedDate: null,
    recurrenceInterval: item.recurrenceInterval,
    impactWeight: item.impactWeight || 3,
    removed: false,
    removalReason: null,
  };
}

// ── "Due this week" + overdue filter ──
export function isDueThisWeekOrOverdue(item, now) {
  now = now || Date.now();
  var st = itemStatus(item, now);
  if (st === 'completed' || st === 'removed' || st === 'skipped') return false;
  if (st === 'overdue') return true;
  if (!item.dueDate) return true;
  var weekEnd = startOfDay(now).getTime() + 7 * DAY_MS;
  // Surface high-prep items when it's time to START (due minus lead time).
  var startBy = startOfDay(item.dueDate).getTime() - (item.leadTimeDays || 0) * DAY_MS;
  return startBy <= weekEnd;
}

// When the user should begin a prep-heavy item (due minus lead time).
export function startByDate(item) {
  if (!item.dueDate || !item.leadTimeDays) return null;
  return new Date(new Date(item.dueDate).getTime() - item.leadTimeDays * DAY_MS);
}

// ── Metrics trend (local, deterministic — no AI) ──
// Compares the most recent value to the prior one for a field; returns a label
// and direction so the UI can color momentum without spending a Gemini call.
export function metricsTrend(entries, field) {
  var pts = (entries || [])
    .filter(function (e) { return typeof e[field] === 'number'; })
    .sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  if (pts.length < 2) return { direction: 'unknown', label: 'not enough data', delta: 0 };
  var last = pts[pts.length - 1][field];
  var prev = pts[pts.length - 2][field];
  var delta = last - prev;
  var pct = prev === 0 ? (last > 0 ? 1 : 0) : delta / prev;
  if (pct > 0.05) return { direction: 'growing', label: 'growing', delta: delta };
  if (pct < -0.05) return { direction: 'declining', label: 'declining', delta: delta };
  return { direction: 'flat', label: 'flat', delta: delta };
}

// ── ASO keyword rank (free iTunes Search API; iOS) ──
// Returns 1-based rank of the app for the keyword, or null if not in top 100.
export async function fetchKeywordRank(keyword, appStoreId) {
  var url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(keyword) +
    '&country=us&entity=software&limit=100';
  var res = await fetch(url);
  if (!res.ok) throw new Error('iTunes search failed: ' + res.status);
  var data = await res.json();
  var results = data.results || [];
  for (var i = 0; i < results.length; i++) {
    if (String(results[i].trackId) === String(appStoreId)) return i + 1;
  }
  return null;
}

function asoKey(campaignId) { return 'rengage-aso-' + campaignId; }
export async function loadRankHistory(campaignId) {
  return (await store.get(asoKey(campaignId))) || [];
}
export async function saveRankHistory(campaignId, history) {
  await store.set(asoKey(campaignId), history);
}

// ── Persistence (per campaign) ──
function actionsKey(campaignId) { return 'rengage-actions-' + campaignId; }
function metricsKey(campaignId) { return 'rengage-metrics-' + campaignId; }

export async function loadActionItems(campaignId) {
  return (await store.get(actionsKey(campaignId))) || [];
}
export async function saveActionItems(campaignId, items) {
  await store.set(actionsKey(campaignId), items);
}
export async function loadMetrics(campaignId) {
  return (await store.get(metricsKey(campaignId))) || [];
}
export async function saveMetrics(campaignId, entries) {
  await store.set(metricsKey(campaignId), entries);
}
