// AI module - uses Gemini API for context generation and reply drafting
// In production, these calls would go through your own backend
// so the API key stays server-side. For now, key is stored on device.

import store from './store';

let apiKey = null;
let usageLog = { totalPromptTokens: 0, totalResponseTokens: 0, calls: 0, history: [] };

export async function loadApiKey() {
  apiKey = await store.get('rengage-gemini-key');
  var saved = await store.get('rengage-usage');
  if (saved) usageLog = saved;
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

  var contents = [];
  if (systemPrompt) {
    contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: contents }),
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Gemini ' + res.status + ': ' + errText.slice(0, 200));
  }

  var data = await res.json();
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

export async function aiScorePosts(posts, campaignContext) {
  if (!posts.length) return [];

  // Batch into groups of 10 to keep token count manageable
  var BATCH_SIZE = 10;
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
