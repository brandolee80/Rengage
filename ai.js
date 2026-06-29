// AI module - uses Gemini API for context generation and reply drafting
// In production, these calls would go through your own backend
// so the API key stays server-side. For now, key is stored on device.

import store from './store';

let apiKey = null;
let usageLog = { totalPromptTokens: 0, totalResponseTokens: 0, calls: 0, history: [] };

// ── Model + quota governor ──
// All configurable in Settings. Free-tier limits are small and vary by model:
//   2.5 Flash / 3 Flash: 5 RPM, 20 RPD   |   2.5 Flash Lite: 10 RPM, 20 RPD
//   3.1 Flash Lite: 15 RPM, 500 RPD (recommended — far higher daily quota)
var MODEL = 'gemini-3.1-flash-lite';
var RPM_LIMIT = 15;
var RPD_LIMIT = 500;
function spacingMs() { return Math.ceil(60000 / Math.max(1, RPM_LIMIT)) + 500; } // +0.5s margin

var rpmChain = Promise.resolve();
var lastCallAt = 0;
var rpdState = null; // { day: 'YYYY-M-D', count: n }, persisted

function todayKey() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

// Serialize + space calls so concurrent batches can't burst past the RPM limit.
function rpmThrottle() {
  rpmChain = rpmChain.then(async function () {
    var wait = Math.max(0, lastCallAt + spacingMs() - Date.now());
    if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
    lastCallAt = Date.now();
  });
  return rpmChain;
}

async function checkDailyBudget() {
  if (!rpdState) rpdState = (await store.get('rengage-ai-rpd')) || { day: todayKey(), count: 0 };
  if (rpdState.day !== todayKey()) rpdState = { day: todayKey(), count: 0 };
  if (rpdState.count >= RPD_LIMIT) {
    throw new Error('Daily AI budget reached (' + RPD_LIMIT + '). Resets tomorrow.');
  }
  rpdState.count += 1;
  await store.set('rengage-ai-rpd', rpdState);
}

export async function getAiBudget() {
  if (!rpdState || rpdState.day !== todayKey()) {
    rpdState = (await store.get('rengage-ai-rpd')) || { day: todayKey(), count: 0 };
    if (rpdState.day !== todayKey()) rpdState = { day: todayKey(), count: 0 };
  }
  return { used: rpdState.count, limit: RPD_LIMIT };
}

export function getAiConfig() {
  return { model: MODEL, rpm: RPM_LIMIT, rpd: RPD_LIMIT };
}

export async function setAiConfig(cfg) {
  if (cfg.model != null) { MODEL = cfg.model; await store.set('rengage-ai-model', cfg.model); }
  if (cfg.rpm != null) { RPM_LIMIT = cfg.rpm; await store.set('rengage-ai-rpm', cfg.rpm); }
  if (cfg.rpd != null) { RPD_LIMIT = cfg.rpd; await store.set('rengage-ai-rpd-limit', cfg.rpd); }
}

export async function loadApiKey() {
  apiKey = await store.get('rengage-gemini-key');
  var saved = await store.get('rengage-usage');
  if (saved) usageLog = saved;
  var lim = await store.get('rengage-ai-rpd-limit');
  if (lim) RPD_LIMIT = lim;
  var m = await store.get('rengage-ai-model');
  if (m) MODEL = m;
  var rpm = await store.get('rengage-ai-rpm');
  if (rpm) RPM_LIMIT = rpm;
  return apiKey;
}

export async function saveApiKey(key) {
  apiKey = key;
  await store.set('rengage-gemini-key', key);
}

export function hasApiKey() {
  return !!apiKey;
}

export function getUsage() {
  return usageLog;
}

export async function resetUsage() {
  usageLog = { totalPromptTokens: 0, totalResponseTokens: 0, calls: 0, history: [] };
  await store.set('rengage-usage', usageLog);
}

async function trackUsage(metadata, purpose) {
  if (!metadata) return;
  var prompt = metadata.promptTokenCount || 0;
  var response = metadata.candidatesTokenCount || 0;
  usageLog.totalPromptTokens += prompt;
  usageLog.totalResponseTokens += response;
  usageLog.calls += 1;
  usageLog.history.push({
    at: Date.now(),
    purpose: purpose,
    promptTokens: prompt,
    responseTokens: response,
  });
  // Keep only last 200 entries
  if (usageLog.history.length > 200) usageLog.history = usageLog.history.slice(-200);
  await store.set('rengage-usage', usageLog);
}

// Exported for direct use by CampaignSetup conversational flow
export async function callAI(prompt, systemPrompt, purpose) {
  return callGemini(prompt, systemPrompt, purpose);
}

async function callGemini(prompt, systemPrompt, purpose) {
  if (!apiKey) throw new Error('No API key configured');

  // Stay within free-tier RPM/RPD before spending a call.
  await rpmThrottle();
  await checkDailyBudget();

  var contents = [];
  if (systemPrompt) {
    contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + apiKey;
  var reqBody = JSON.stringify({ contents: contents });

  // Retry transient errors (503 overloaded, 500, 429) with backoff.
  var data = null;
  var maxAttempts = 3;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reqBody });
    } catch (e) {
      if (attempt < maxAttempts) { await new Promise(function (r) { setTimeout(r, 1000 * attempt); }); continue; }
      throw new Error('Network error: ' + e.message);
    }
    if (res.ok) { data = await res.json(); break; }
    if ((res.status === 503 || res.status === 500 || res.status === 429) && attempt < maxAttempts) {
      await new Promise(function (r) { setTimeout(r, 1500 * attempt); });
      continue;
    }
    var errText = await res.text().catch(function () { return ''; });
    throw new Error('Gemini ' + res.status + ': ' + errText.slice(0, 200));
  }
  if (!data) throw new Error('Gemini is busy (overloaded). Please try again in a moment.');
  if (data.error) throw new Error(data.error.message);

  var txt = '';
  if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
    data.candidates[0].content.parts.forEach(function (p) {
      if (p.text) txt += p.text;
    });
  }

  // Track usage
  await trackUsage(data.usageMetadata, purpose || 'unknown');

  return txt;
}

function extractJSON(text) {
  var s = text.replace(/```json|```/g, '');
  var depth = 0, start = -1;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '[') { if (!depth) start = i; depth++; }
    if (s[i] === ']') { depth--; if (!depth && start >= 0) return JSON.parse(s.slice(start, i + 1)); }
  }
  // Try object
  depth = 0; start = -1;
  for (var j = 0; j < s.length; j++) {
    if (s[j] === '{') { if (!depth) start = j; depth++; }
    if (s[j] === '}') { depth--; if (!depth && start >= 0) return JSON.parse(s.slice(start, j + 1)); }
  }
  throw new Error('No JSON found in AI response');
}

// ── Generate campaign context from answers ──
export async function generateCampaignContext(answers) {
  var prompt = 'Based on these answers about a product/service, generate:\n\n' +
    '1. A 2-3 paragraph "AI Context" that describes the product naturally, as a Reddit commenter who uses it would describe it. Include the key value props, differentiators, and natural language someone would use when casually mentioning it.\n\n' +
    '2. 5-10 suggested subreddits to monitor (just the names, no r/ prefix)\n\n' +
    '3. 10-15 keywords or phrases to track\n\n' +
    'Answers:\n' +
    '- What does it do: ' + answers.whatItDoes + '\n' +
    '- Who is it for: ' + answers.whoItsFor + '\n' +
    '- What problem does it solve: ' + answers.problemItSolves + '\n' +
    '- How is it different from alternatives: ' + answers.howItsDifferent + '\n' +
    '- What would someone naturally say about it: ' + answers.naturalLanguage + '\n' +
    '- Product name (never mention in comments): ' + answers.productName + '\n\n' +
    'Return as JSON: {"context":"...","subreddits":["..."],"keywords":["..."]}\n' +
    'Output ONLY the JSON object.';

  var raw = await callGemini(prompt, null, 'campaign-setup');
  return extractJSON(raw);
}

// ── Generate reply drafts for a post ──
export async function generateReplies(post, campaignContext) {
  var sys = 'You are a helpful Reddit commenter.\n\n' +
    'Context about the product you use:\n' + campaignContext + '\n\n' +
    'Rules:\n' +
    '- Be genuinely helpful FIRST. Answer their question.\n' +
    '- Sound like a real Reddit user. Casual, concise.\n' +
    '- Never mention the product by name. Reference the concept naturally.\n' +
    '- Never use em dashes. Use commas, periods, or separate sentences.\n' +
    '- 2-4 short paragraphs max.\n' +
    '- Match subreddit tone.\n' +
    '- If the product doesn\'t fit naturally, just be helpful.\n' +
    '- Generate 3 reply options as a JSON array.\n' +
    '- Each: {"text":"...","approach":"4-6 word label","recommended":true/false}\n' +
    '- Exactly one should have recommended: true.\n' +
    '- Output ONLY the JSON array.';

  var prompt = 'Post in r/' + post.subreddit + ':\n' +
    'Title: ' + post.title + '\n' +
    'Body: ' + (post.selftext || '(no body)');

  var raw = await callGemini(prompt, sys, 'reply-draft');
  return extractJSON(raw);
}

// ── AI relevance scoring (pass 2) ──
// Takes posts that passed keyword matching and scores them with AI context
var SCORE_SYSTEM = 'You are evaluating Reddit posts for marketing relevance. Given a product context and a batch of posts, rate each post 0-100 on how natural and effective it would be to leave a helpful comment that subtly mentions the product concept.\n\nScore higher for:\n- Posts where the user has a problem the product solves\n- Posts asking for recommendations or advice\n- Posts expressing frustration with current solutions\n- Fewer existing comments (more visibility)\n\nScore lower for:\n- Posts where mentioning the product would feel forced\n- Posts that are just news or announcements\n- Posts with 100+ comments already\n\nReturn a JSON array of objects: [{"id":"post_id","score":75,"reason":"one sentence why"}]\nOutput ONLY the JSON array.';

// ── Marketing plan generation ──
var PLAN_SYSTEM = 'You are a pragmatic startup marketing strategist. Given a product\'s marketing context and market grade, design a COMPREHENSIVE, concrete marketing action plan tailored to THIS specific product and audience.\n\nWork through every channel category below. For each, decide what genuinely fits THIS product and create a SEPARATE action item for each specific opportunity (e.g. one item per directory, one per community, one per outreach target). The names below are EXAMPLES to spark your thinking — include the ones that fit, skip those that do not, and add other relevant ones you know of for this niche. Do NOT just output the examples verbatim; reason about what actually suits this product and audience, and vary the plan to the product.\n\nCRITICAL: every action must be a DELIVERABLE you can fully write for the user (a post, article, listing blurb, outreach message, or launch submission). Do NOT create vague ongoing to-dos like "engage with the community", "comment on relevant posts", or "participate in X" - those need live context the user must find and cannot be pre-written, so leave them out entirely. Ongoing Reddit engagement is handled by a separate feature. If you cannot write the complete content for an action, do not include it.\n\nTAILOR TO THIS APP: the channels in ALWAYS INCLUDE are the universal floor and appear in every plan. Everything ABOVE that floor must be derived from THIS app\'s specific audience, niche, and positioning, not a generic template. Name the SPECIFIC niche subreddits, Discord servers, forums, directories, newsletters, podcasts, and listicle outlets that match THIS product (a running app belongs in r/running and running newsletters; a dev tool belongs in programming communities and dev newsletters; a budgeting app in r/personalfinance-adjacent maker spaces). OMIT any channel or platform that does not fit this audience instead of padding the plan with it (a CLI dev tool gets no TikTok action; a B2B tool gets no teen-focused channel). Two different apps should produce visibly different plans once you get past the shared launch floor. If you are adding a channel that could apply to literally any app, replace it with a niche-specific one drawn from this app\'s context.\n\nALWAYS INCLUDE these core app-launch channels (each as its own action with writable content, unless truly irrelevant to this app): a Product Hunt launch; a Hacker News "Show HN" post; an App Store feature nomination to Apple; text friends and family; maker communities r/SideProject, r/iOSapps, r/roastmyapp, r/apps, r/TestFlight or r/alphaandbetausers, and Indie Hackers; and the directories BetaList, Launching Next, and AlternativeTo.\n\n1. App directories & listing sites (one item per relevant directory): examples include indieappcatalog, AlternativeTo (as an alternative to named competitors), BetaList, Launching Next, AppAdvice — plus other directories that fit this kind of app.\n2. App Store optimization & featuring: pitch Apple for a feature/nomination; refine ASO keywords and screenshots.\n3. Maker / developer communities (one item per community): examples include Show HN on Hacker News, Indie Hackers, and showcase subreddits such as r/SideProject, r/indiedev, r/roastmyapp, r/alphaandbetausers, r/iosapps, r/apphookup, r/TestFlight — plus other maker communities that fit.\n4. Content & SEO: e.g. a Medium article, a comparison or listicle post, a YouTube demo or short.\n5. Social (evaluate EACH platform and include ONLY the ones where THIS audience actually spends time, OMITTING the rest - a developer tool likely skips TikTok, a teen consumer app likely skips LinkedIn; add a recurring posting action per included platform): X, Instagram, TikTok, LinkedIn, Facebook.\n6. Outreach & PR (one item per target type): pitch listicle authors and journalists at outlets relevant to THIS niche, plus newsletters and podcasts; generate the outreach.\n7. Personal network: text friends and family, post on your own personal accounts.\n8. Discord: ONLY one-time launch posts in servers that have a self-promo or show-your-work channel (you write the post). Do NOT add ongoing Discord engagement actions.\n9. Partnerships & creators: if paid is allowed, paid sponsorships or paid influencers (paid:true). If free only, include the FREE organic versions instead: a creator-outreach DM, an indie cross-promotion swap, or a revenue-share affiliate signup (paid:false). You write the outreach message.\n\nReddit rule: ongoing commenting and replying is handled by a separate feature, so NEVER create commenting, replying, or answering actions, and NEVER suggest promotional posts in topical communities (e.g. r/personalfinance) — that gets accounts banned. Reddit actions = one-time launch/showcase POSTS in the maker/showcase subreddits from category 3 only.\n\nIMPACT WEIGHTS (1-5) = REALISTIC, PROBABILITY-ADJUSTED expected impact, NOT best-case ceiling. Cold outreach to strangers (podcasters, journalists, influencers, listicle authors) has LOW response rates, so weight it modestly (2-3) even though a hit would be large. Baselines, then adjust per audience:\n- 5: personal asks like texting friends and family (high impact AND high response, since people you know actually reply).\n- 4: a Medium/SEO article, an App Store featuring pitch, a Product Hunt launch.\n- 3: Instagram, TikTok, or LinkedIn posts, directory submissions, maker-community posts.\n- 2: an X post, a cold outreach pitch, cross-posting existing content.\n- 1: reshares and low-traffic channels.\nAdjust per audience: a B2B tool might raise LinkedIn and lower TikTok; a consumer app the reverse.\n\nPHASES: assign every action to one phase and sequence its dueInDays to match:\n- Phase 1 Pre-Launch (build anticipation). Put the App Store feature nomination here, since Apple wants roughly three weeks of lead time before launch.\n- Phase 2 Launch Day & Acquisition (drive installs).\n- Phase 3 Post-Launch (retention & monetization, ongoing).\n\nEFFORT & LEAD TIME: rate each action\'s effort 1-5 (1 = quick post, 5 = significant build/setup like an affiliate integration). For high-effort items that need preparation (joining affiliate platforms, coding an integration, producing a video), set leadTimeDays to the days of prep needed before the due date so the user is prompted to start early.\n\nCOVERAGE is a MINIMUM, never a target — do NOT stop at one item per category. Every applicable category MUST be represented, and for enumerable categories (app directories, maker communities, outreach targets) create a SEPARATE item for EVERY relevant opportunity you can think of, so those categories each yield MULTIPLE items (e.g. several directory submissions, several maker-community posts, several outreach pitches). Also include at least 4 one-time launch actions of impact weight 4 or 5. When a product fits many channels, lean to the fuller end. Do not pad with junk, but do not under-deliver — be genuinely thorough.\n\nProduce a JSON array of 18 to 30 action items (more if the product genuinely warrants it) spanning all relevant categories, mixing one-time launch actions and recurring ongoing actions. Each item:\n{"platform":"the channel","type":"one-time" or "recurring","phase":1 2 or 3,"title":"short imperative title","dueInDays":integer days from today,"leadTimeDays":integer prep days needed before it can be done (0 for quick items),"recurrenceInterval":integer days between repeats (only for recurring, otherwise null),"impactWeight":1-5 realistic probability-adjusted expected impact,"effort":1-5 time and work required (1 quick, 5 significant build/setup),"paid":true if it costs money (ads, paid influencers, paid placements) otherwise false,"rationale":"one short line on why this matters"}\n\nSpread one-time launch items across dueInDays 0-30, sequenced sensibly (foundational items first). For RECURRING actions, set the first dueInDays to 0-3 so the cadence starts now and appears this week — NEVER push recurring social weeks out. Use realistic cadences (recurrenceInterval in days): X/Twitter every 1-2 days, Instagram and TikTok every 2-3 days, LinkedIn every 2-3 days, Facebook every 3-4 days, Medium or other long-form every 14-30 days. Never use em dashes. Output ONLY the JSON array.';

export async function generatePlan(campaign) {
  var ctx = (campaign.context || '').slice(0, 4000);
  var market = campaign.market || {};
  var paidLine = campaign.includePaid
    ? 'Paid actions are allowed: include relevant paid channels (e.g. Apple Search Ads, paid creators) and set paid:true on anything that costs money.'
    : 'FREE / ORGANIC ONLY: do NOT include any action that costs money (no paid ads, no paid influencer payments, no paid placements). Set paid:false on every item.';
  var prompt = 'Product: ' + campaign.name + '\nMarket grade: ' + (market.grade || 'n/a') + '\n\nContext:\n' + ctx + '\n\n' + paidLine;
  var raw = await callGemini(prompt, PLAN_SYSTEM, 'plan-generate');
  var arr = extractJSON(raw);
  return Array.isArray(arr) ? arr : [];
}

// ── Adaptive Boost: suggest NEW untried channels ──
var BOOST_SYSTEM = 'You are a growth strategist suggesting NEW marketing actions a founder has not tried yet. Given the product context, the channels and actions already in their plan, and their results so far, suggest 3 to 5 NEW actions on channels or strategies they are NOT already using (or a meaningfully different angle on a channel). Do NOT duplicate any existing platform or title.\n\nEvery suggestion must be a DELIVERABLE you can fully write (a post, article, listing, or outreach message). Do NOT suggest vague "engage with the community" or "comment on posts" to-dos. Weight impactWeight 1-5 as REALISTIC probability-adjusted expected impact (cold outreach scores 2-3, not its best-case ceiling). Reddit: no commenting and no promotional posts in topical subs, only launch/showcase posts in maker subreddits. Return a JSON array of items: {"platform":"...","type":"one-time" or "recurring","phase":1 2 or 3,"title":"...","dueInDays":int,"leadTimeDays":int,"recurrenceInterval":int or null,"impactWeight":1-5,"effort":1-5,"paid":true/false,"rationale":"why this fills a gap"}. Output ONLY the JSON array.';

export async function generateBoost(campaign, existing, situation) {
  var ctx = (campaign.context || '').slice(0, 3000);
  var used = (existing || []).map(function (it) { return it.platform + ': ' + it.title; }).join('; ').slice(0, 1800);
  var paidLine = campaign.includePaid ? 'Paid actions are allowed.' : 'FREE / ORGANIC ONLY: no paid actions.';
  var prompt = 'Product: ' + campaign.name + '\n\nContext:\n' + ctx
    + '\n\nAlready in the plan (do NOT repeat these):\n' + used
    + '\n\nSituation: ' + (situation || 'looking for fresh untried channels.')
    + '\n\n' + paidLine;
  var raw = await callGemini(prompt, BOOST_SYSTEM, 'boost');
  var arr = extractJSON(raw);
  return Array.isArray(arr) ? arr : [];
}

// ── Per-action content (generated lazily when the user opens an item) ──
var CONTENT_SYSTEM = 'You write ready-to-post marketing content. Given a product context and one action (its platform and title), write the content for that platform in the founder\'s authentic voice, matching the platform\'s format and conventions. Be genuine, never generic or salesy. Never use em dashes.\n\nReturn JSON: {"body":"the main text, ready to post","fields":[{"label":"...","value":"..."}]} where fields holds every extra platform-specific piece the user needs (for example: hashtags, tagline, subject line, article title, topics, video concept, suggested image description). Include everything that platform requires so the user can copy and paste it all. Output ONLY the JSON object.';

// Object-only JSON extraction (extractJSON grabs the first array, which breaks
// objects that contain a "fields" array).
function extractJSONObject(text) {
  var s = text.replace(/```json|```/g, '');
  var depth = 0, start = -1;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '{') { if (!depth) start = i; depth++; }
    if (s[i] === '}') { depth--; if (!depth && start >= 0) return JSON.parse(s.slice(start, i + 1)); }
  }
  throw new Error('No JSON object found in AI response');
}

export async function generateActionContent(campaign, item) {
  var ctx = (campaign.context || '').slice(0, 3000);
  var prompt = 'Platform: ' + item.platform + '\nAction: ' + item.title
    + '\n\nProduct context:\n' + ctx
    + (campaign.toneExamples ? '\n\nFounder tone examples (match this voice):\n' + campaign.toneExamples.slice(0, 800) : '');
  var raw = await callGemini(prompt, CONTENT_SYSTEM, 'action-content');
  var obj = extractJSONObject(raw);
  if (obj && (typeof obj.body === 'string' || Array.isArray(obj.fields))) {
    return { body: obj.body || '', fields: Array.isArray(obj.fields) ? obj.fields : [] };
  }
  // Fallback: model returned platform-specific top-level keys — render as fields.
  var fields = Object.keys(obj || {}).map(function (k) {
    var v = obj[k];
    if (Array.isArray(v)) v = v.join(', ');
    else if (v && typeof v === 'object') v = JSON.stringify(v);
    return { label: k, value: String(v) };
  });
  return { body: '', fields: fields };
}

export async function aiScorePosts(posts, campaignContext) {
  if (!posts.length) return [];

  // Batch into groups of 20 to halve the number of scoring calls
  var BATCH_SIZE = 20;
  var allScores = [];

  for (var i = 0; i < posts.length; i += BATCH_SIZE) {
    var batch = posts.slice(i, i + BATCH_SIZE);
    var postsText = batch.map(function (p) {
      return '- ID: ' + p.id + ' | r/' + p.subreddit + ' | ' + p.num_comments + ' comments\n  Title: ' + p.title.slice(0, 150) + '\n  Body: ' + (p.selftext || '').slice(0, 200);
    }).join('\n\n');

    var prompt = 'Product context:\n' + campaignContext.slice(0, 800) + '\n\nPosts to evaluate:\n\n' + postsText;

    try {
      var raw = await callGemini(prompt, SCORE_SYSTEM, 'ai-scoring');
      var scores = extractJSON(raw);
      allScores = allScores.concat(scores);
    } catch (e) {
      // If AI scoring fails for a batch, keep the local scores
      console.warn('AI scoring batch failed:', e.message);
    }
  }

  return allScores;
}
