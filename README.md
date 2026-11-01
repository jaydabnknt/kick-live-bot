# Kick live alerts bot

A private Telegram bot that posts in your groups and channels when chosen Kick streamers go live, with a Telegram Mini App for managing it. It runs on the Cloudflare Workers free plan.

## Files

- `worker.js` is the whole bot: Telegram webhook, live checks (cron), the Mini App page and its API.
- `src/app.html` is the Mini App source. After editing it, run `node scripts/build-app.mjs` to copy it into `worker.js`.
- `wrangler.jsonc` holds the Cloudflare settings: worker name, D1 database, and the every-minute cron.

## Deploying

Every push to `main` deploys automatically through Cloudflare Workers Builds (Worker → Settings → Builds).

Secrets live only in the Cloudflare dashboard and are kept on every deploy:
`BOT_TOKEN`, `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`, `WEBHOOK_SECRET`.

After adding a new bot command, open `/setup?secret=<WEBHOOK_SECRET>` on the worker once to refresh Telegram's command list and menu button.
