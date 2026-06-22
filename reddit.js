// Reddit module
// Routes through Cloudflare Worker proxy using RSS feeds for subreddit posts
// Uses .json endpoints for individual post comments (via same proxy)
// Deep links to Reddit app for posting

import store from './store';

var PROXY_BASE = 'https://reddit-proxy.brandonleesheffield.workers.dev/';

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

// ── Proxy fetch helper ──
async function proxyFetch(params) {
  var query = Object.keys(params).map(function (k) {
    return k + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var url = PROXY_BASE + '?' + query;
  console.log('[Rengage] Fetching:', url);
  var res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error('Network error: ' + e.message);
  }
  if (!res.ok) {
    var errText = '';
    try { errText = await res.text(); } catch (e2) {}
    throw new Error('Proxy ' + res.status + ': ' + errText.slice(0, 150));
  }
  return res;
}

// ── Parse RSS XML into post objects (no DOMParser in React Native) ──
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

  // Split on <entry> tags
  var parts = xmlText.split(/<entry>/i);
  // First part is the feed header, skip it
  for (var i = 1; i < parts.length; i++) {
    var chunk = parts[i].split(/<\/entry>/i)[0];

    var title = getTag(chunk, 'title');
    // Decode HTML entities
    title = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    var author = getTag(chunk, 'name');
    author = author.replace(/^\/u\//, '');

    var link = getAttr(chunk, 'link', 'href');

    var updated = getTag(chunk, 'updated');

    var content = getTag(chunk, 'content');
    // Decode HTML entities in content then strip tags
    content = content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    var selftext = content.replace(/<[^>]*>/g, '').trim().slice(0, 500);

    // Parse permalink from URL
    var permalink = '';
    try {
      permalink = link.replace('https://www.reddit.com', '');
    } catch (e) {
      permalink = link;
    }

    // Extract post ID
    var idMatch = permalink.match(/\/comments\/([a-z0-9]+)/);
    var id = idMatch ? idMatch[1] : 'rss-' + i;

    // Convert ISO timestamp to unix epoch
    var created_utc = updated ? Math.floor(new Date(updated).getTime() / 1000) : 0;

    // Extract subreddit
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

// ── Fetch subreddit posts via RSS proxy ──
export async function fetchSubredditPosts(subreddit) {
  var sub = subreddit.replace(/^r\//i, '').trim();
  var res = await proxyFetch({ sub: sub });
  var xmlText = await res.text();
  return parseRSS(xmlText);
}

// ── Fetch with keyword search via RSS proxy ──
export async function searchSubredditPosts(subreddit, query) {
  var sub = subreddit.replace(/^r\//i, '').trim();
  var res = await proxyFetch({ sub: sub, q: query });
  var xmlText = await res.text();
  return parseRSS(xmlText);
}

// ── Fetch post comments via JSON (through proxy) ──
async function jsonFetch(path) {
  var redditUrl = 'https://www.reddit.com' + path;
  var res = await proxyFetch({ url: redditUrl });
  return res.json();
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
  if (!user) return [];

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
      console.warn('Follow-up check failed for', entry.url, e.message);
    }
  }

  followUps.sort(function (a, b) {
    if (a.needsFollowUp && !b.needsFollowUp) return -1;
    if (!a.needsFollowUp && b.needsFollowUp) return 1;
    return b.latestReply.created_utc - a.latestReply.created_utc;
  });

  return followUps;
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
