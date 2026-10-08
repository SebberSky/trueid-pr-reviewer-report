# TrueID PR reviewer report

Cloudflare Worker that counts Bitbucket PR approvals (`participants[].approved === true`) across configured repositories. It loads the previous completed month on entry, supports month checkboxes and multiple repository filters, and stores up to 12 monthly JSON reports. Jarvis is excluded.

The deployed ChatGPT Site uses the `REPORTS` R2 binding declared in `.openai/hosting.json`. A standalone Wrangler deployment can use the `STATS` KV binding in `wrangler.toml`. Configure `BITBUCKET_REPO_SLUGS` as a comma-separated list for multi-repository reports. `index.js` is the standalone Sites entrypoint; `src/index.js` imports the UI from `src/ui.js` for Wrangler.

## Setup

1. Create two KV namespaces and replace the IDs in `wrangler.toml`.
2. Install Wrangler and authenticate: `npm install -D wrangler` then `npx wrangler login`.
3. Set secrets (never commit them):

```sh
npx wrangler secret put BITBUCKET_USERNAME
npx wrangler secret put BITBUCKET_APP_PASSWORD
npx wrangler secret put RUN_SECRET
```

4. Deploy: `npx wrangler deploy`.

The cron trigger runs at `02:00 UTC` on the first day of every month and processes the previous calendar month. Cloudflare cron times are UTC. The public routes are `/`, `/api/latest`, and `/api/YYYY-MM`. Manual runs require `POST /run` with an `x-run-secret` header.

## Local validation

Use `npx wrangler dev` after configuring KV and secrets in `.dev.vars`. The opening page displays full-screen loading while fetching the latest completed month. Other months load only when selected.

## Data and safety

The collector requests participant fields explicitly, deduplicates PR IDs across states, and never logs credentials or authorization headers. Counts reflect current approval flags on PRs updated within each reporting month, rather than historical approval-event timestamps. Monthly reports persist as JSON; loading an existing month reads storage instead of fetching every month.
