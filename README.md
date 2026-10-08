# TrueID PR reviewer report

Cloudflare Free Worker that counts actual Bitbucket PR approvals (`participants[].approved === true`) for `truedmp/trueid-ios-v3`, stores monthly reports in KV, and serves a responsive HTML report.

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

Use `npx wrangler dev` after configuring a local KV namespace and secrets in `.dev.vars`. The Worker deliberately returns an empty-state page until a real report exists; it does not ship fake metrics.

## Data and safety

The collector requests participant fields explicitly, deduplicates PR IDs across states, stops paginating once records are older than the window, and never logs credentials or authorization headers. Jarvis reviewers are retained in the report and marked `bot`; human share percentages exclude them.
