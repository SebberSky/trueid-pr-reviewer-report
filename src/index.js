const STATES = ["MERGED", "OPEN", "DECLINED"];
const FIELDS = [
  "values.id", "values.state", "values.updated_on",
  "values.participants.user.display_name", "values.participants.user.nickname",
  "values.participants.user.uuid", "values.participants.approved", "values.participants.role",
  "next", "size"
].join(",");

export default {
  async scheduled(event, env, ctx) {
    const { since, until } = previousMonth(new Date(event.scheduledTime || Date.now()));
    ctx.waitUntil(runAndStore(env, since, until));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/run") {
        if (!env.RUN_SECRET || request.headers.get("x-run-secret") !== env.RUN_SECRET) {
          return json({ error: "Unauthorized" }, 401);
        }
        const { since, until } = previousMonth(new Date());
        const result = await runAndStore(env, since, until);
        return json(result);
      }
      if (request.method === "GET" && url.pathname === "/api/latest") {
        const latest = await getLatest(env);
        return latest ? json(latest) : json({ error: "No report has been generated yet" }, 404);
      }
      const month = url.pathname.match(/^\/api\/(\d{4}-\d{2})$/)?.[1];
      if (request.method === "GET" && month) {
        const report = env.STATS ? await env.STATS.get(`stats:${month}`) : null;
        return report ? json(JSON.parse(report)) : json({ error: "Report not found" }, 404);
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return htmlReport(await getLatest(env));
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Worker error");
      return json({ error: "Unable to complete request" }, 500);
    }
  }
};

async function runAndStore(env, since, until) {
  const report = await collect(env, since, until);
  if (env.STATS) {
    const month = since.slice(0, 7);
    await env.STATS.put(`stats:${month}`, JSON.stringify(report));
    await env.STATS.put("stats:latest", JSON.stringify(report));
  }
  return report;
}

async function getLatest(env) {
  if (env.STATS) {
    const latest = await env.STATS.get("stats:latest");
    if (latest) return JSON.parse(latest);
  }
  const { since, until } = previousMonth(new Date());
  try {
    return await runAndStore(env, since, until);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to load latest report");
    return null;
  }
}

async function collect(env, since, until) {
  const auth = btoa(`${env.BITBUCKET_USERNAME}:${env.BITBUCKET_APP_PASSWORD}`);
  const seen = new Map();
  const stateCounts = { MERGED: 0, OPEN: 0, DECLINED: 0 };
  for (const state of STATES) {
    let next = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(env.BITBUCKET_WORKSPACE)}/${encodeURIComponent(env.BITBUCKET_REPO_SLUG)}/pullrequests?q=${encodeURIComponent(`state="${state}" AND updated_on>=\"${since}\"`)}&sort=-updated_on&pagelen=50&fields=${encodeURIComponent(FIELDS)}`;
    while (next) {
      const response = await fetch(next, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
      if (!response.ok) throw new Error(`Bitbucket API returned ${response.status}`);
      const page = await response.json();
      for (const pr of page.values || []) {
        if (!pr.id || seen.has(pr.id)) continue;
        if (!pr.updated_on || pr.updated_on.slice(0, 10) >= since && pr.updated_on.slice(0, 10) <= until) {
          seen.set(pr.id, pr);
          stateCounts[pr.state] = (stateCounts[pr.state] || 0) + 1;
        }
      }
      const oldest = page.values?.at(-1)?.updated_on?.slice(0, 10);
      next = oldest && oldest < since ? null : page.next || null;
    }
  }
  const people = new Map();
  for (const pr of seen.values()) {
    for (const participant of pr.participants || []) {
      if (!participant.approved || !participant.user) continue;
      const user = participant.user;
      const key = user.uuid || user.nickname || user.display_name;
      const current = people.get(key) || { name: user.display_name || user.nickname || "Unknown", uuid: user.uuid || null, approvals: 0, note: null };
      current.approvals += 1;
      if (/jarvis/i.test(current.name)) current.note = "bot";
      people.set(key, current);
    }
  }
  const approvals = [...people.values()].sort((a, b) => b.approvals - a.approvals || a.name.localeCompare(b.name));
  return { repo: `${env.BITBUCKET_WORKSPACE}/${env.BITBUCKET_REPO_SLUG}`, since, until, pr_total: seen.size, state_counts: stateCounts, total_approvals: approvals.reduce((n, x) => n + x.approvals, 0), approvals, generated_at: new Date().toISOString() };
}

function previousMonth(date) {
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
  return { since: first.toISOString().slice(0, 10), until: last.toISOString().slice(0, 10) };
}

function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }

function htmlReport(report) {
  const payload = report ? JSON.stringify(report).replace(/</g, "\\u003c") : "null";
  const title = report ? `Review approvals · ${report.since} – ${report.until}` : "Review approvals";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Monthly Bitbucket pull request approval report"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23d9ff57'/%3E%3Cpath d='M8 9h16v4H8zm0 7h11v4H8z' fill='%230b0e0d'/%3E%3C/svg%3E"><title>${escapeHtml(title)}</title><style>${css()}</style></head><body><main><header><div class="eyebrow">TRUEID IOS · BITBUCKET</div><h1>Review approvals</h1><p class="lede">A monthly view of approvals recorded on pull requests.</p></header>${report ? reportMarkup(report) : '<section class="empty"><h2>No report yet</h2><p>Run the monthly job or trigger <code>POST /run</code> to generate the first report.</p></section>'}</main><script>window.__REPORT__=${payload};</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function reportMarkup(r) {
  const humans = r.approvals.filter(x => x.note !== "bot");
  const max = r.approvals[0]?.approvals || 1;
  const rows = r.approvals.map((x, i) => `<tr><td class="rank">${String(i + 1).padStart(2, "0")}</td><td><span class="person">${escapeHtml(x.name)}</span>${x.note === "bot" ? '<span class="tag">BOT</span>' : ''}</td><td class="barcell"><span class="bar" style="width:${Math.max(2, x.approvals / max * 100)}%"></span></td><td class="count">${x.approvals}</td><td class="share">${x.note === "bot" ? '—' : `${(x.approvals / Math.max(1, humans.reduce((n, y) => n + y.approvals, 0)) * 100).toFixed(1)}%`}</td></tr>`).join('');
  return `<section class="context"><div><span class="label">REPORTING PERIOD</span><strong>${r.since} <span>→</span> ${r.until}</strong></div><div><span class="label">REPOSITORY</span><strong>${escapeHtml(r.repo)}</strong></div><a href="/api/latest">View raw JSON</a></section><section class="cards"><article><span>Pull requests</span><strong>${r.pr_total}</strong><small>${r.state_counts.MERGED || 0} merged · ${r.state_counts.OPEN || 0} open · ${r.state_counts.DECLINED || 0} declined</small></article><article class="accent"><span>Total approvals</span><strong>${r.total_approvals}</strong><small>${humans.length} human approvers</small></article><article><span>Top approver</span><strong>${escapeHtml(r.approvals[0]?.name || '—')}</strong><small>${r.approvals[0]?.approvals || 0} approvals</small></article></section><section class="tablewrap"><div class="tablehead"><h2>Approvals by person</h2><span>Sorted high to low</span></div><table><thead><tr><th>RANK</th><th>REVIEWER</th><th></th><th>APPROVALS</th><th>SHARE OF HUMAN</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="emptyrow">No approvals found for this period.</td></tr>'}</tbody></table></section><footer>Generated ${new Date(r.generated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</footer>`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function css() { return `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#edf2eb;background:#0b0e0d;line-height:1.45}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0%,#27352b 0,transparent 35%),#0b0e0d}main{max-width:1180px;margin:auto;padding:72px 28px 48px}.eyebrow,.label,th{font-size:12px;letter-spacing:.13em;font-weight:700;color:#9ba89e}.eyebrow{color:#d9ff57;margin-bottom:18px}h1{font-size:clamp(42px,7vw,82px);line-height:.98;letter-spacing:-.06em;margin:0;max-width:700px}.lede{color:#aab5aa;font-size:19px;margin:22px 0 54px}.context{border-top:1px solid #344137;border-bottom:1px solid #344137;padding:20px 0;display:grid;grid-template-columns:1fr 1fr auto;gap:24px;align-items:end}.label{display:block;margin-bottom:5px}.context strong{font-size:15px}.context strong span{color:#718071;padding:0 3px}.context a{color:#d9ff57;text-decoration:none;font-size:14px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:28px 0}.cards article{background:#131915;border:1px solid #2d3930;border-radius:16px;padding:22px;min-height:150px}.cards article.accent{background:#d9ff57;color:#0b0e0d;border-color:#d9ff57}.cards span,.cards small{display:block;font-size:14px;color:#9ba89e}.cards .accent span,.cards .accent small{color:#39452f}.cards strong{display:block;font-size:38px;letter-spacing:-.04em;margin:22px 0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tablewrap{background:#111612;border:1px solid #2d3930;border-radius:16px;overflow:hidden}.tablehead{display:flex;justify-content:space-between;align-items:center;padding:22px 24px;border-bottom:1px solid #2d3930}.tablehead h2{font-size:18px;margin:0}.tablehead span{font-size:13px;color:#718071}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:15px 18px;border-bottom:1px solid #263128}th{font-size:11px;padding-top:14px;padding-bottom:10px}tbody tr:last-child td{border:0}.rank{color:#718071;width:65px}.person{font-weight:650}.tag{color:#0b0e0d;background:#d9ff57;border-radius:4px;font-size:10px;font-weight:800;margin-left:8px;padding:3px 5px}.barcell{width:35%}.bar{display:block;height:8px;background:#d9ff57;border-radius:9px;min-width:4px}.count{font-variant-numeric:tabular-nums;font-weight:700;width:100px}.share{color:#aab5aa;width:130px}.empty,.emptyrow{text-align:center;color:#aab5aa}.empty{border:1px solid #2d3930;border-radius:16px;padding:64px 24px}.empty h2{color:#edf2eb}code{color:#d9ff57}footer{color:#718071;font-size:12px;margin-top:20px}@media(max-width:760px){main{padding:40px 16px}.context{grid-template-columns:1fr 1fr}.context a{grid-column:1/-1}.cards{grid-template-columns:1fr}.cards article{min-height:auto}.cards strong{margin-top:14px}.tablewrap{overflow-x:auto}table{min-width:680px}.lede{font-size:17px;margin-bottom:36px}}`; }
