# Deploying Kestrel (always-on production)

Kestrel runs entirely on Vercel plus three free managed services. No VPS.

| Piece | Service | Why |
| :--- | :--- | :--- |
| Web app + API + MCP | **Vercel** | Serves every route 24/7 |
| Shared state (desks, watches, x402 replay ledger, caches) | **Upstash Redis** (free) | Serverless functions keep no memory between requests |
| Pager heartbeat (watch checks every 4 min) | **Upstash QStash** (free) or **cron-job.org** | Vercel Hobby cron runs at most once a day |
| Telegram inbound updates | Telegram **webhook** to `/api/pager/telegram/webhook` | Telegram pushes `/start` links to the app |

---

## 1. Create the Vercel project

1. Import the private GitHub repo `mrnetwork0001/Kestrel` in Vercel (framework: Next.js, defaults are fine).
2. Add the environment variables from section 2 **before** the first deploy (or redeploy after adding them).
3. After the first deploy, note the production URL (e.g. `https://kestrel-xyz.vercel.app`) and set `NEXT_PUBLIC_APP_URL` to it, then redeploy.

## 2. Environment variables

Required:

| Variable | Value |
| :--- | :--- |
| `NEXT_PUBLIC_APP_URL` | Production URL, no trailing slash |
| `NEXT_PUBLIC_BASE_RPC_URL` | `https://mainnet.base.org` (or a keyed Base RPC) |
| `NEXT_PUBLIC_BASE_FALLBACK_RPC_URL` | `https://base-rpc.publicnode.com` |
| `NEXT_PUBLIC_ROBINHOOD_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | From the Upstash Redis database (or the Vercel KV integration's `KV_REST_API_URL` / `KV_REST_API_TOKEN`) |
| `CRON_SECRET` | Long random string (`openssl rand -hex 32`) |
| `PAGER_IP_SALT` | Long random string |

Morning Desk Brief (optional; without it Kestrel writes a rule-based brief from live metrics):

| Variable | Value |
| :--- | :--- |
| `ZG_COMPUTE_API_KEY`, `ZG_COMPUTE_BASE_URL` | Copy from `.env.local` |
| `ZG_COMPUTE_MODEL` | `claude-sonnet-5.5` |
| `BRIEF_LLM_DAILY_CAP` | `300` |

Telegram pager:

| Variable | Value |
| :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_BOT_USERNAME` | Bot username without `@` |
| `TELEGRAM_WEBHOOK_SECRET` | Random string, letters/digits/`_`/`-` only (`openssl rand -hex 24`) |

x402 paid agent tier (optional; free preview tier works without it):

| Variable | Value |
| :--- | :--- |
| `X402_RECEIVER_ADDRESS` | Base address that receives USDC (not the demo wallet) |
| `X402_PRICE_USDC_ATOMIC` | `10000` (= 0.01 USDC) |
| `X402_FACILITATOR` | `auto` (CDP if keys present, else PayAI keyless) |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Optional, Coinbase CDP facilitator |

Optional: `GITHUB_TOKEN` (raises the GitHub rate limit for founder-velocity reads), `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (WalletConnect / mobile wallets), `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` (if using QStash, see 3a).

Never set `PAGER_INPROCESS` on Vercel; the in-process scheduler is for local dev and disables itself on Vercel.

## 3. Pager heartbeat (pick one)

The endpoint is `https://<APP_URL>/api/pager/tick`. The app expects a check every 4 minutes (`PAGER_CADENCE_SEC`, default 240). That is 360 messages a day, inside the QStash free plan's 500/day. If you schedule a different interval, set `PAGER_CADENCE_SEC` to match (in seconds) so `/api/pager/status` judges staleness correctly.

### 3a. Upstash QStash (recommended)

1. Upstash console → QStash → **Schedules** → Create.
2. Destination: `https://<APP_URL>/api/pager/tick`, method `POST`, cron `*/4 * * * *`, retries `0` (retries count toward the daily message limit; a missed check is covered by the next one).
3. Install QStash from Vercel Storage (Upstash QStash/Workflow, Free plan, **no custom prefix**) so `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` are added automatically, then redeploy. Requests are verified by signature.

### 3b. cron-job.org

1. Create a job: URL `https://<APP_URL>/api/pager/tick?async=1`, every 4 minutes, method `GET`.
2. Advanced → Headers: `Authorization: Bearer <CRON_SECRET>`.
3. `async=1` makes the endpoint answer 202 at once (cron-job.org times out at 30 s).

Check it: `curl -H "Authorization: Bearer $CRON_SECRET" "https://<APP_URL>/api/pager/tick?dry=1"` must return JSON, not 401. The public Night-Shift Log at `/api/pager/status` shows the last tick time.

## 4. Telegram webhook (one-time, after deploy)

```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<APP_URL>/api/pager/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","my_chat_member","channel_post"]'
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Note: once a webhook is set, local dev with the same bot can no longer poll (Telegram returns 409). Use a second bot for localhost, or run `deleteWebhook` while testing locally.

## 5. Smoke test after deploy

1. `/` renders live block numbers and the Sentinel Watch moves.
2. `/app?target=0x0e9bf34baed84a80d7647dafe4db52169147c911&chain=8453` (Genesis escrow) loads Backer Shield.
3. Parity tab shows both chains (confirms Robinhood Chain RPC is reachable from Vercel IPs).
4. `/api/v1/guard?address=0xefFC8815487084a97edfdfF968b56Ea123421Acb&chainId=8453` returns a verdict; with `X402_RECEIVER_ADDRESS` set, the paid path returns HTTP 402 with `PAYMENT-REQUIRED`.
5. `POST /api/mcp` `tools/list` returns 11 tools; `/llms.txt` and `/api/openapi.json` load.
6. Pager: create a desk → LINK TELEGRAM → press Start in the bot → **Send Live Test Pager** arrives with a working `/rescue` link.
7. `/api/pager/status` shows a tick within the last few minutes.

## Plan notes

Vercel Hobby works (all functions cap at 60 s). Pro is recommended for a public launch: higher function limits and no fair-use pauses during the judging/vote week.
