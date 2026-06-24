// Rengage Reddit proxy — Cloudflare Worker
//
// Uses authenticated Reddit OAuth (application-only / client_credentials) so
// requests draw on a per-app rate budget (~100 req/min) instead of the heavily
// throttled unauthenticated shared-IP pool that returns 429/403.
//
// Required Worker secrets (wrangler secret put / dashboard > Settings > Variables):
//   REDDIT_CLIENT_ID      — the id under your app name at reddit.com/prefs/apps
//   REDDIT_CLIENT_SECRET  — the app secret
//
// Routes (all return Reddit JSON):
//   ?sub=foo                 -> /r/foo/new        (listing, newest first)
//   ?sub=foo&q=bar           -> /r/foo/search     (search within subreddit)
//   ?url=https://www.reddit.com/comments/abc.json  -> proxied comments JSON

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent",
};

// Reddit asks for a unique, descriptive User-Agent: platform:appid:version (by /u/user)
const USER_AGENT = "rengage:com.rengage.app:1.0 (by /u/brandonleesheffield)";

// In-isolate token cache (best effort — survives across requests on a warm isolate).
let cachedToken = null;
let cachedExpiry = 0;

async function getToken(env) {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry) return cachedToken;

  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) {
    throw new Error("Worker missing REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET secrets");
  }

  const basic = btoa(env.REDDIT_CLIENT_ID + ":" + env.REDDIT_CLIENT_SECRET);
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + basic,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Token request failed " + res.status + ": " + t.slice(0, 120));
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Refresh a minute early to avoid edge-of-expiry failures.
  cachedExpiry = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function redditGet(targetUrl, env) {
  const token = await getToken(env);
  return fetch(targetUrl, {
    headers: {
      "Authorization": "Bearer " + token,
      "User-Agent": USER_AGENT,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const urlObj = new URL(request.url);
    const rawSub = urlObj.searchParams.get("sub");
    const query = urlObj.searchParams.get("q") || "";
    const passthroughUrl = urlObj.searchParams.get("url");

    try {
      let targetUrl;

      if (passthroughUrl) {
        // Comments / arbitrary Reddit JSON path. Route through the OAuth host;
        // oauth.reddit.com always returns JSON, so drop any trailing ".json".
        const u = new URL(passthroughUrl);
        u.hostname = "oauth.reddit.com";
        u.pathname = u.pathname.replace(/\.json$/i, "");
        targetUrl = u.toString();
      } else if (rawSub) {
        const sub = rawSub.replace(/r\//gi, "").trim();
        if (query) {
          targetUrl =
            "https://oauth.reddit.com/r/" + sub + "/search?" +
            "q=" + encodeURIComponent(query) +
            "&sort=new&restrict_sr=1&limit=25&raw_json=1";
        } else {
          targetUrl = "https://oauth.reddit.com/r/" + sub + "/new?limit=25&raw_json=1";
        }
      } else {
        return new Response("Missing required 'sub' or 'url' parameter.", {
          status: 400,
          headers: CORS,
        });
      }

      const redditResponse = await redditGet(targetUrl, env);

      if (!redditResponse.ok) {
        // Surface Reddit's own status so the client can back off appropriately.
        const retryAfter = redditResponse.headers.get("retry-after");
        const headers = Object.assign({}, CORS);
        if (retryAfter) headers["Retry-After"] = retryAfter;
        return new Response("Reddit responded with status: " + redditResponse.status, {
          status: redditResponse.status,
          headers,
        });
      }

      const body = await redditResponse.text();
      return new Response(body, {
        headers: Object.assign({ "Content-Type": "application/json" }, CORS),
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: Object.assign({ "Content-Type": "application/json" }, CORS),
      });
    }
  },
};
