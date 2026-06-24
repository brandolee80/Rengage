// Reddit module
// Fetches Reddit's public .json endpoints directly from the device (residential
// IP), which Reddit tolerates at low volume where datacenter IPs get blocked.
// Deep links to Reddit app for posting.

import store from './store';

var REDDIT_BASE = 'https://www.reddit.com';
// Reddit 403s blank/unrecognized clients on the public .json endpoints. Since
// the request really does come from an iPhone, send a genuine mobile-Safari
// User-Agent — Reddit is far more permissive toward browser-shaped requests.
var USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// ── Username ──
let username = '';

export async function loadUsername() {
  username = (await store.get('rengage-username')) || '';
  return username;
}

export async function saveUsername(name) {
  username = name;
  await store.set('rengage-username', name);
}

export function getUsername() {
  return username;
}

// ── Reddit fetch helper ──
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Core fetch with retry/backoff. Returns the raw body text and throws
// *diagnostic* errors so we can tell the failure modes apart:
//   "Reddit 429"           -> rate-limited (back off / slow down)
//   "Blocked by Reddit"     -> 403/HTML block page (Reddit refuses the client)
//   "Reddit 4xx/5xx"        -> other upstream error
async function redditFetchRaw(path) {
  var url = REDDIT_BASE + path;
  console.log('[Rengage] Fetching:', url);

  var maxAttempts = 4;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
      if (attempt < maxAttempts) {
        await delay(600 * attempt);
        continue;
      }
      throw new Error('Network error: ' + e.message);
    }

    // Rate-limited / temporarily unavailable: back off and retry.
    if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
      var retryAfter = parseInt(res.headers.get('retry-after'), 10);
      var waitMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, attempt - 1);
      console.warn('[Rengage] ' + res.status + ' on attempt ' + attempt + ', retrying in ' + waitMs + 'ms');
      await delay(waitMs);
      continue;
    }

    var body = await res.text();

    if (!res.ok) {
      throw new Error('Reddit ' + res.status + ': ' + body.slice(0, 120));
    }

    // Soft-block detection: when Reddit blocks, it serves its web page
    // (class=theme-beta) or a generic HTML doc instead of the feed/JSON.
    var head = body.replace(/^﻿/, '').replace(/^\s+/, '').slice(0, 200).toLowerCase();
    if (head.indexOf('theme-beta') !== -1 || head.indexOf('<!doctype html') !== -1 || head.indexOf('<html') === 0) {
      throw new Error('Blocked by Reddit (HTML block page)');
    }

    return body;
  }
  throw new Error('Reddit rate-limited after ' + maxAttempts + ' attempts');
}

async function redditFetchJson(path) {
  var body = await redditFetchRaw(path);
  var trimmed = body.replace(/^﻿/, '').replace(/^\s+/, '');
  if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') {
    throw new Error('Non-JSON response — starts: ' + trimmed.slice(0, 60));
  }
  return JSON.parse(trimmed);
}

// ── Parse Reddit Atom/RSS XML into post objects (no DOMParser in RN) ──
function getTag(xml, tag) {
  var re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var m = xml.match(re);
  return m ? m[1].trim() : '';
}

function getAttr(xml, tag, attr) {
  var re = new RegExp('<' + tag + '[^>]*' + attr + '=["\']([^"\']*)["\']', 'i');
  var m = xml.match(re);
  return m ? m[1] : '';
}

function parseRSS(xmlText) {
  var posts = [];
  var parts = xmlText.split(/<entry>/i);
  for (var i = 1; i < parts.length; i++) {
    var chunk = parts[i].split(/<\/entry>/i)[0];

    var title = getTag(chunk, 'title');
    title = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    var author = getTag(chunk, 'name').replace(/^\/u\//, '');
    var link = getAttr(chunk, 'link', 'href');
    var updated = getTag(chunk, 'updated');

    var content = getTag(chunk, 'content');
    content = content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    var selftext = content.replace(/<[^>]*>/g, '').trim().slice(0, 500);

    var permalink = link.replace('https://www.reddit.com', '');
    var idMatch = permalink.match(/\/comments\/([a-z0-9]+)/);
    var id = idMatch ? idMatch[1] : 'rss-' + i;
    var created_utc = updated ? Math.floor(new Date(updated).getTime() / 1000) : 0;
    var subMatch = permalink.match(/\/r\/([^\/]+)/);
    var subreddit = subMatch ? subMatch[1] : '';

    if (title) {
      posts.push({
        id: id,
        title: title,
        subreddit: subreddit,
        author: author,
        url: link.indexOf('http') === 0 ? link : 'https://www.reddit.com' + link,
        permalink: permalink,
        selftext: selftext,
        created_utc: created_utc,
        num_comments: 0,
        score: 0,
      });
    }
  }
  return posts;
}

// ── Fetch subreddit posts via Reddit's RSS feed ──
// Reddit treats .rss more leniently than .json (it's meant for feed readers),
// so this is our best shot at unauthenticated access. `sub` is left un-encoded
// so multi-sub groupings ("a+b+c") keep working.
export async function fetchSubredditPosts(subreddit) {
  var sub = subreddit.replace(/^r\//i, '').trim();
  var xml = await redditFetchRaw('/r/' + sub + '/new/.rss?limit=25');
  var posts = parseRSS(xml);
  console.log('[Rengage] Parsed ' + posts.length + ' posts from r/' + sub);
  return posts;
}

// ── Fetch with keyword search via Reddit's RSS feed ──
export async function searchSubredditPosts(subreddit, query) {
  var sub = subreddit.replace(/^r\//i, '').trim();
  var xml = await redditFetchRaw(
    '/r/' + sub + '/search.rss?q=' + encodeURIComponent(query) +
    '&restrict_sr=1&sort=new&limit=25'
  );
  return parseRSS(xml);
}

// ── Fetch post comments (JSON; .rss has no comment trees) ──
// Note: if Reddit 403s .json this will fail, leaving follow-ups degraded even
// when the RSS-based scan works. That's an accepted limitation of no-auth access.
async function jsonFetch(path) {
  return redditFetchJson(path);
}

export async function fetchPostComments(postId) {
  var data = await jsonFetch('/comments/' + postId + '.json?limit=200&raw_json=1');
  if (!data[1] || !data[1].data || !data[1].data.children) return [];
  return data[1].data.children
    .filter(function (c) { return c.data && c.data.author; })
    .map(function (c) {
      var d = c.data;
      return {
        id: d.id,
        author: d.author,
        body: (d.body || '').slice(0, 300),
        created_utc: d.created_utc || 0,
        parent_id: d.parent_id || '',
      };
    });
}

// ── Deep link to Reddit app ──
export function getRedditDeepLink(permalink) {
  return 'https://www.reddit.com' + permalink;
}

// ── Inbox replies via private RSS feed ──
// Reddit exposes a token-protected RSS feed of replies/mentions at
// reddit.com/prefs/feeds ("RSS feed of your private messages"). This uses the
// RSS path (which works) instead of the blocked .json comment endpoints.
function parseInboxRSS(xmlText) {
  var items = [];
  var parts = xmlText.split(/<entry>/i);
  for (var i = 1; i < parts.length; i++) {
    var chunk = parts[i].split(/<\/entry>/i)[0];

    var title = getTag(chunk, 'title')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    var author = getTag(chunk, 'name').replace(/^\/u\//, '');
    var link = getAttr(chunk, 'link', 'href');
    var updated = getTag(chunk, 'updated');
    var content = getTag(chunk, 'content')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    var body = content.replace(/<[^>]*>/g, '').trim().slice(0, 500);
    var created_utc = updated ? Math.floor(new Date(updated).getTime() / 1000) : 0;
    var subMatch = link.match(/\/r\/([^\/]+)/);
    var subreddit = subMatch ? subMatch[1] : '';

    items.push({
      author: author,
      title: title,
      body: body,
      link: link,
      created_utc: created_utc,
      subreddit: subreddit,
    });
  }
  return items;
}

// Pass the full feed URL copied from reddit.com/prefs/feeds.
export async function fetchInboxReplies(inboxUrl) {
  if (!inboxUrl) return { items: [], error: 'no-url' };
  var path = inboxUrl.trim().replace(/^https?:\/\/[^/]+/i, '');
  try {
    var xml = await redditFetchRaw(path);
    return { items: parseInboxRSS(xml), error: '' };
  } catch (e) {
    return { items: [], error: e.message };
  }
}

// ── Follow-up tracking ──
function flattenComments(children, arr) {
  if (!children) return arr;
  var list = Array.isArray(children) ? children : [];
  if (children.data && children.data.children) list = children.data.children;
  list.forEach(function (c) {
    if (c.data && c.data.author) {
      arr.push({
        id: c.data.id,
        author: c.data.author,
        body: (c.data.body || '').slice(0, 300),
        created_utc: c.data.created_utc || 0,
        parent_id: c.data.parent_id || '',
        fullname: 't1_' + c.data.id,
      });
      if (c.data.replies) flattenComments(c.data.replies, arr);
    }
  });
  return arr;
}

export async function checkFollowUps(commentLog, user) {
  if (!user) return { items: [], total: 0, failed: 0, error: '' };

  var userLower = user.toLowerCase();
  var entries = Object.keys(commentLog).map(function (url) {
    return Object.assign({ url: url }, commentLog[url]);
  });

  var weekAgo = Date.now() - 7 * 86400000;
  var recent = entries.filter(function (e) {
    var at = new Date(e.at).getTime();
    return at > weekAgo;
  });

  recent.sort(function (a, b) { return new Date(b.at).getTime() - new Date(a.at).getTime(); });
  recent = recent.slice(0, 20);

  var followUps = [];
  var failed = 0;
  var sampleError = '';

  for (var i = 0; i < recent.length; i++) {
    var entry = recent[i];
    try {
      var match = entry.url.match(/\/comments\/([a-z0-9]+)/);
      if (!match) continue;
      var postId = match[1];

      var data = await jsonFetch('/comments/' + postId + '.json?limit=500&raw_json=1');
      if (!data[1] || !data[1].data) continue;

      var allComments = flattenComments(data[1].data.children, []);

      var myComments = allComments.filter(function (c) {
        return c.author.toLowerCase() === userLower;
      });

      if (myComments.length === 0) continue;

      myComments.forEach(function (myComment) {
        var replies = allComments.filter(function (c) {
          return c.parent_id === myComment.fullname && c.author.toLowerCase() !== userLower;
        });

        if (replies.length > 0) {
          var latestReply = replies.sort(function (a, b) { return b.created_utc - a.created_utc; })[0];
          var userRepliedBack = allComments.some(function (c) {
            return c.parent_id === ('t1_' + latestReply.id) && c.author.toLowerCase() === userLower;
          });

          followUps.push({
            postUrl: entry.url,
            postTitle: entry.title,
            subreddit: entry.sub,
            campaign: entry.campaign,
            myComment: myComment.body.slice(0, 150),
            latestReply: {
              author: latestReply.author,
              body: latestReply.body,
              created_utc: latestReply.created_utc,
            },
            replyCount: replies.length,
            needsFollowUp: !userRepliedBack,
            commentedAt: entry.at,
          });
        }
      });

      if (i < recent.length - 1) {
        await new Promise(function (resolve) { setTimeout(resolve, 300); });
      }
    } catch (e) {
      failed++;
      if (!sampleError) sampleError = e.message;
      console.warn('Follow-up check failed for', entry.url, e.message);
    }
  }

  followUps.sort(function (a, b) {
    if (a.needsFollowUp && !b.needsFollowUp) return -1;
    if (!a.needsFollowUp && b.needsFollowUp) return 1;
    return b.latestReply.created_utc - a.latestReply.created_utc;
  });

  return { items: followUps, total: recent.length, failed: failed, error: sampleError };
}

// ── Posting frequency tracker ──
let postLog = [];

export async function loadPostLog() {
  postLog = (await store.get('rengage-postlog')) || [];
  return postLog;
}

export async function logPost(subreddit) {
  postLog.push({ sub: subreddit.toLowerCase(), at: Date.now() });
  if (postLog.length > 200) postLog = postLog.slice(-200);
  await store.set('rengage-postlog', postLog);
}

export function getPostFrequencyWarning(subreddit) {
  var sub = subreddit.toLowerCase();
  var oneHourAgo = Date.now() - 3600000;
  var oneDayAgo = Date.now() - 86400000;

  var lastHour = postLog.filter(function (p) { return p.sub === sub && p.at > oneHourAgo; }).length;
  var lastDay = postLog.filter(function (p) { return p.sub === sub && p.at > oneDayAgo; }).length;

  if (lastHour >= 3) return 'You\'ve commented in r/' + subreddit + ' 3+ times in the last hour. Slow down to avoid looking spammy.';
  if (lastDay >= 8) return 'You\'ve commented in r/' + subreddit + ' 8+ times today. Reddit may flag frequent posters.';
  return null;
}
