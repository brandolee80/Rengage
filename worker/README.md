# Rengage Reddit proxy (Cloudflare Worker)

Authenticated proxy between the app and Reddit. Uses application-only OAuth so
requests use a per-app rate budget (~100 req/min) instead of the throttled
unauthenticated shared-IP pool (which returns 429/403).

## One-time setup

1. **Create a Reddit app:** https://www.reddit.com/prefs/apps → *create another app*
   - type: **script**
   - redirect uri: `http://localhost`
   - Note the **client id** (string under the app name) and **secret**.

2. **Set the secrets** (from this `worker/` folder):
   ```sh
   npx wrangler secret put REDDIT_CLIENT_ID
   npx wrangler secret put REDDIT_CLIENT_SECRET
   ```
   Or in the Cloudflare dashboard: Workers → reddit-proxy → Settings → Variables →
   add both as **encrypted** variables.

3. **Deploy:**
   ```sh
   npx wrangler deploy
   ```

## Routes

| Request                                   | Reddit endpoint                |
|-------------------------------------------|--------------------------------|
| `?sub=budgeting`                          | `/r/budgeting/new` (JSON)      |
| `?sub=budgeting&q=savings`                | `/r/budgeting/search` (JSON)   |
| `?url=https://www.reddit.com/comments/abc.json` | proxied comments JSON    |

All responses are JSON. On Reddit error the worker passes the upstream status
through (and `Retry-After` when present) so the app can back off.

## Quick test

```sh
curl -i "https://reddit-proxy.brandonleesheffield.workers.dev/?sub=budgeting"
```
Expect `HTTP 200` and a JSON body whose `data.children` array is non-empty.
