const STATES = ["MERGED", "OPEN", "DECLINED"];
const FIELDS = [
  "values.id", "values.state", "values.updated_on",
  "values.participants.user.display_name", "values.participants.user.nickname",
  "values.participants.user.uuid", "values.participants.approved", "values.participants.role",
  "next", "size"
].join(",");
let LAST_REPORT = null;
const IN_FLIGHT = new Map();
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

export default {
  async scheduled(event, env, ctx) {
    const { since, until } = previousMonth(new Date(event.scheduledTime || Date.now()));
    ctx.waitUntil(runAndStore(env, since, until));
  },
  async fetch(request, env, ctx) {
    if (!env.STATS && env.REPORTS) env = { ...env, STATS: {
      get: async key => { const object = await env.REPORTS.get(key); return object ? object.text() : null; },
      put: (key, value) => env.REPORTS.put(key, value),
      delete: key => env.REPORTS.delete(key)
    }};
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
        const latest = url.searchParams.get("refresh") === "1"
          ? await runAndStore(env, previousMonth(new Date()).since, previousMonth(new Date()).until)
          : await getLatest(env);
        return latest ? json(latest) : json({ error: "No report has been generated yet" }, 404);
      }
      const month = url.pathname.match(/^\/api\/(\d{4}-\d{2})$/)?.[1];
      if (request.method === "GET" && month) {
        const stored = env.STATS ? await env.STATS.get(`stats:${month}`) : null;
        if (stored) return json(JSON.parse(stored));
        const { since, until } = monthWindow(month);
        return json(await runAndStore(env, since, until));
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return appPage(css());
      }
      if (request.method === "GET" && url.pathname === "/report") {
        return appPage(css());
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Worker error");
      return json({ error: "Unable to complete request" }, 500);
    }
  }
};

async function runAndStore(env, since, until) {
  const month = since.slice(0, 7);
  const key = `stats:${month}`;
  const cached = env.STATS ? await env.STATS.get(key) : null;
  if (cached) {
    const report = JSON.parse(cached);
    if (Date.now() - new Date(report.generated_at || 0).getTime() < REFRESH_COOLDOWN_MS) {
      LAST_REPORT = report;
      return report;
    }
  }
  // Worker promises cannot safely be shared across request lifetimes.
  const job = (async () => {
    try {
      const report = await collect(env, since, until);
      LAST_REPORT = report;
      if (env.STATS) {
        await env.STATS.put(key, JSON.stringify(report));
        await env.STATS.put("stats:latest", JSON.stringify(report));
        const months = JSON.parse(await env.STATS.get("stats:months") || "[]");
        if (!months.includes(month)) months.push(month);
        months.sort();
        while (months.length > 12) {
          const expired = months.shift();
          await env.STATS.delete(`stats:${expired}`);
        }
        await env.STATS.put("stats:months", JSON.stringify(months));
      }
      return report;
    } catch (error) {
      if (cached) {
        const report = JSON.parse(cached);
        LAST_REPORT = report;
        return report;
      }
      throw error;
    } finally {
      IN_FLIGHT.delete(key);
    }
  })();
  IN_FLIGHT.set(key, job);
  return job;
}

async function getLatest(env) {
  const { since, until } = previousMonth(new Date());
  if (env.STATS) {
    const stored = await env.STATS.get(`stats:${since.slice(0, 7)}`);
    if (stored) return JSON.parse(stored);
  }
  if (LAST_REPORT?.since === since) return LAST_REPORT;
  try {
    return await runAndStore(env, since, until);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to load latest report");
    return null;
  }
}

async function collect(env, since, until) {
  const repos = (env.BITBUCKET_REPO_SLUGS || env.BITBUCKET_REPO_SLUG || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!repos.length) throw new Error("No Bitbucket repositories configured");
  const auth = btoa(`${env.BITBUCKET_USERNAME}:${env.BITBUCKET_APP_PASSWORD}`);
  const seen = new Map();
  const stateCounts = { MERGED: 0, OPEN: 0, DECLINED: 0 };
  const people = new Map();
  const repoResults = await Promise.all(repos.map(async repo => {
    const repoSeen = new Map();
    const repoCounts = { MERGED: 0, OPEN: 0, DECLINED: 0 };
    for (const state of STATES) {
      const endExclusive = new Date(new Date(until + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0,10);
      let next = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(env.BITBUCKET_WORKSPACE)}/${encodeURIComponent(repo)}/pullrequests?q=${encodeURIComponent(`state="${state}" AND updated_on>="${since}" AND updated_on<"${endExclusive}"`)}&sort=-updated_on&pagelen=50&fields=${encodeURIComponent(FIELDS)}`;
      while (next) {
        const response = await fetch(next, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
        if (!response.ok) throw new Error(`Bitbucket API returned ${response.status} for ${repo}`);
        const page = await response.json();
        for (const pr of page.values || []) {
          const key = `${repo}:${pr.id}`;
          if (!pr.id || repoSeen.has(pr.id)) continue;
          if (!pr.updated_on || pr.updated_on.slice(0, 10) >= since && pr.updated_on.slice(0, 10) <= until) {
            repoSeen.set(pr.id, pr);
            seen.set(key, { ...pr, _repo: repo });
            repoCounts[pr.state] = (repoCounts[pr.state] || 0) + 1;
          }
        }
        const oldest = page.values?.at(-1)?.updated_on?.slice(0, 10);
        next = oldest && oldest < since ? null : page.next || null;
      }
    }
    return { repo, repoSeen, repoCounts };
  }));
  for (const { repo, repoSeen, repoCounts } of repoResults) {
    for (const [state, count] of Object.entries(repoCounts)) stateCounts[state] += count;
    for (const [id, pr] of repoSeen) seen.set(`${repo}:${id}`, { ...pr, _repo: repo });
    for (const pr of repoSeen.values()) {
      for (const participant of pr.participants || []) {
        if (!participant.approved || !participant.user) continue;
        const user = participant.user;
        const name = user.display_name || user.nickname || "Unknown";
        if (/jarvis/i.test(name)) continue;
        const key = user.uuid || user.nickname || user.display_name;
        const current = people.get(key) || { name, uuid: user.uuid || null, approvals: 0, note: null };
        current.approvals += 1;
        people.set(key, current);
      }
    }
  }
  const approvals = [...people.values()].sort((a, b) => b.approvals - a.approvals || a.name.localeCompare(b.name));
  const per_repo = repos.map(slug => {
    const prs = [...seen.values()].filter(pr => pr._repo === slug);
    const p = new Map();
    for (const pr of prs) for (const participant of pr.participants || []) {
      const name = participant.user?.display_name || participant.user?.nickname || "Unknown";
      if (!participant.approved || !participant.user || /jarvis/i.test(name)) continue;
      const key = participant.user.uuid || participant.user.nickname || name;
      const current = p.get(key) || { name, uuid: participant.user.uuid || null, approvals: 0, note: null };
      current.approvals += 1; p.set(key, current);
    }
    const a = [...p.values()].sort((x, y) => y.approvals - x.approvals || x.name.localeCompare(y.name));
    const states = { MERGED: 0, OPEN: 0, DECLINED: 0 }; prs.forEach(pr => states[pr.state] = (states[pr.state] || 0) + 1);
    return { slug, pr_total: prs.length, state_counts: states, total_approvals: a.reduce((n, x) => n + x.approvals, 0), approvals: a };
  });
  return { repos: repos.map(repo => `${env.BITBUCKET_WORKSPACE}/${repo}`), per_repo, repo: `${env.BITBUCKET_WORKSPACE} · ${repos.length} repositories`, since, until, pr_total: seen.size, state_counts: stateCounts, total_approvals: approvals.reduce((n, x) => n + x.approvals, 0), approvals, generated_at: new Date().toISOString() };
}

function previousMonth(date) {
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
  return { since: first.toISOString().slice(0, 10), until: last.toISOString().slice(0, 10) };
}

function monthWindow(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error("Invalid month");
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const first = new Date(Date.UTC(year, index, 1));
  const next = new Date(Date.UTC(year, index + 1, 1));
  const current = new Date();
  const isCurrent = year === current.getUTCFullYear() && index === current.getUTCMonth();
  const last = isCurrent ? current : new Date(next.getTime() - 86400000);
  return { since: first.toISOString().slice(0, 10), until: last.toISOString().slice(0, 10) };
}

function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }

function htmlReport(report) {
  const payload = report ? JSON.stringify(report).replace(/</g, "\\u003c") : "null";
  const title = report ? `Review approvals · ${report.since} – ${report.until}` : "Review approvals";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Monthly Bitbucket pull request approval report"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23d9ff57'/%3E%3Cpath d='M8 9h16v4H8zm0 7h11v4H8z' fill='%230b0e0d'/%3E%3C/svg%3E"><title>${escapeHtml(title)}</title><style>${css()}</style></head><body><main><header><div class="eyebrow">TRUEID · BITBUCKET</div><h1>Review approvals</h1><p class="lede">A monthly view of approvals recorded on pull requests.</p></header>${report ? reportMarkup(report) : emptyMarkup()}</main><script>window.__REPORT__=${payload};${report ? '' : `const b=document.querySelector('#refresh');b?.addEventListener('click',async()=>{b.disabled=true;b.textContent='Fetching…';const r=await fetch('/api/latest?refresh=1');if(r.ok){location.reload()}else{b.disabled=false;b.textContent='Try again';document.querySelector('#refresh-status').textContent='Unable to fetch the report. Check the Worker secrets and try again.'}});`}</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function emptyMarkup() { return '<section class="empty"><h2>No report yet</h2><p>Fetch the most recent completed calendar month directly from Bitbucket.</p><button id="refresh" type="button">Fetch latest full month</button><p id="refresh-status" class="status" role="status"></p></section>'; }

function loadingPage() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TRUEID · BITBUCKET</title><style>${css()} .landing{min-height:70vh;display:grid;place-items:center;text-align:center}.loader{width:min(520px,100%);padding:36px;border:1px solid #2d3930;border-radius:20px;background:#111612}.loader h2{font-size:28px;margin:0 0 10px}.loader p{color:#9ba89e;margin:0 0 26px}.spinner{width:28px;height:28px;margin:0 auto 22px;border:3px solid #344137;border-top-color:#d9ff57;border-radius:50%;animation:spin .8s linear infinite}.progress{height:8px;background:#263128;border-radius:10px;overflow:hidden}.progress i{display:block;height:100%;width:8%;background:#d9ff57;border-radius:10px;transition:width .25s ease}@keyframes spin{to{transform:rotate(360deg)}}.landing small{display:block;color:#718071;margin-top:14px}</style></head><body><main><div class="eyebrow">TRUEID · BITBUCKET</div><section class="landing"><div class="loader"><div class="spinner"></div><h2 id="load-title">Loading review activity</h2><p id="load-copy">Reading the latest saved report…</p><div class="progress"><i id="load-progress"></i></div><small>Use the month selector after the report opens to fetch another period.</small></div></section></main><script>const p=document.querySelector('#load-progress'),t=document.querySelector('#load-title'),c=document.querySelector('#load-copy');let n=8;const timer=setInterval(()=>{n=Math.min(92,n+Math.ceil(Math.random()*7));p.style.width=n+'%'},700);const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),60000);fetch('/api/latest',{signal:controller.signal}).then(async r=>{clearTimeout(timeout);if(!r.ok)throw new Error('Report request failed');await r.json();location.href='/report'}).catch(e=>{clearTimeout(timeout);clearInterval(timer);p.style.width='100%';t.textContent='Unable to load report';c.textContent=e.name==='AbortError'?'The data source took too long to respond.':'Please try again in a moment.';document.querySelector('.loader').insertAdjacentHTML('beforeend','<button class="empty button" onclick="location.reload()">Try again</button>')});</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function reportClientPage(report) {
  const payload = report ? JSON.stringify(report).replace(/</g, "\\u003c") : "null";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review approvals</title><style>${css()}.months{background:#111612;border:1px solid #2d3930;border-radius:16px;padding:18px;margin:20px 0}.months h2{font-size:16px;margin:0 0 12px}.month-grid{display:flex;flex-wrap:wrap;gap:8px}.month-grid label{border:1px solid #2d3930;border-radius:999px;padding:7px 11px;color:#aab5aa;font-size:13px;cursor:pointer}.month-grid input{accent-color:#d9ff57;margin-right:5px}.load-months{margin-top:14px;border:0;border-radius:999px;background:#d9ff57;color:#0b0e0d;padding:11px 18px;font:inherit;font-weight:750;cursor:pointer}.load-months:disabled{opacity:.6}.load-status{color:#9ba89e;font-size:13px;margin-left:10px}</style></head><body><main><header><div class="eyebrow">TRUEID · BITBUCKET</div><h1>Review approvals</h1><p class="lede">Monthly approval activity across the configured repositories.</p></header><div id="app"><section class="empty"><h2>Loading report…</h2><p>Preparing the report data.</p></section></div></main><script>let r=${payload};if(!r){location.href='/';}else{const months=[];const now=new Date();for(let i=0;i<12;i++){const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1));months.push(d.toISOString().slice(0,7))}const checks=months.map((m,i)=>'<label><input type="checkbox" value="'+m+'" '+(i===0?'checked':'')+'>'+m+'</label>').join('');document.querySelector('#app').innerHTML='<section class="months"><h2>Months to review</h2><div class="month-grid">'+checks+'</div><button class="load-months" id="loadMonths">Load selected months</button><span class="load-status" id="loadStatus"></span></section><div id="reportBody"></div>';function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}function draw(d){const tabs=(d.per_repo||[]).map((x,i)=>'<button class="repo-tab" data-i="'+i+'">'+esc(x.slug)+'</button>').join('');const rows=d.approvals.map((x,i)=>'<tr><td class="rank">'+String(i+1).padStart(2,'0')+'</td><td class="person">'+esc(x.name)+'</td><td class="barcell"><span class="bar" style="width:'+Math.max(2,x.approvals/(d.approvals[0]?.approvals||1)*100)+'%"></span></td><td class="count">'+x.approvals+'</td></tr>').join('');document.querySelector('#reportBody').innerHTML='<section class="context"><div><span class="label">REPORTING PERIOD</span><strong>'+d.since+' → '+d.until+'</strong></div><div><span class="label">SCOPE</span><strong>'+d.repos.length+' repositories</strong></div><a href="/api/latest">View raw JSON</a></section><div class="repo-tabs"><button class="repo-tab active">All repos</button>'+tabs+'</div><section class="cards"><article><span>Pull requests</span><strong>'+d.pr_total+'</strong><small>'+(d.state_counts.MERGED||0)+' merged · '+(d.state_counts.OPEN||0)+' open · '+(d.state_counts.DECLINED||0)+' declined</small></article><article class="accent"><span>Human approvals</span><strong>'+d.total_approvals+'</strong><small>'+d.approvals.length+' approvers</small></article><article><span>Top approver</span><strong>'+esc(d.approvals[0]?.name||'—')+'</strong><small>Jarvis excluded</small></article></section><section class="tablewrap"><div class="tablehead"><h2>Approvals by person</h2><span>Sorted high to low</span></div><table><thead><tr><th>RANK</th><th>REVIEWER</th><th></th><th>APPROVALS</th></tr></thead><tbody>'+rows+'</tbody></table></section>'}draw(r);document.querySelectorAll('.repo-tab').forEach(x=>x.onclick=()=>x.classList.toggle('selected'));document.querySelector('#loadMonths').onclick=async()=>{const selected=[...document.querySelectorAll('.month-grid input:checked')].map(x=>x.value);const b=document.querySelector('#loadMonths'),s=document.querySelector('#loadStatus');b.disabled=true;document.body.insertAdjacentHTML("beforeend","<div class=\"loading-overlay\"><div class=\"loader\"><div class=\"spinner\"></div><h2>Loading selected months</h2><p></p><div class=\"progress\"><i></i></div></div></div>");for(let i=0;i<selected.length;i++){s.textContent='Loading '+selected[i]+' ('+(i+1)+'/'+selected.length+')…';const res=await fetch('/api/'+selected[i]);if(res.ok){r=await res.json();draw(r)}}s.textContent='Loaded '+selected.length+' month(s)';document.querySelector('.loading-overlay')?.remove();b.disabled=false}}</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function reportMarkup(r) {
  const humans = r.approvals.filter(x => x.note !== "bot");
  const max = r.approvals[0]?.approvals || 1;
  const rows = r.approvals.map((x, i) => `<tr><td class="rank">${String(i + 1).padStart(2, "0")}</td><td><span class="person">${escapeHtml(x.name)}</span>${x.note === "bot" ? '<span class="tag">BOT</span>' : ''}</td><td class="barcell"><span class="bar" style="width:${Math.max(2, x.approvals / max * 100)}%"></span></td><td class="count">${x.approvals}</td><td class="share">${x.note === "bot" ? '—' : `${(x.approvals / Math.max(1, humans.reduce((n, y) => n + y.approvals, 0)) * 100).toFixed(1)}%`}</td></tr>`).join('');
  const tabs = (r.per_repo || []).map((repo, i) => `<button class="repo-tab${i === 0 ? ' active' : ''}" data-repo="${i}">${escapeHtml(repo.slug)}</button>`).join('');
  return `<section class="context"><div><span class="label">REPORTING PERIOD</span><strong>${r.since} <span>→</span> ${r.until}</strong></div><div><span class="label">SCOPE</span><strong>${r.per_repo?.length || 0} repositories</strong></div><a href="/api/latest">View raw JSON</a></section><div class="repo-tabs"><button class="repo-tab active" data-repo="all">All repos</button>${tabs}</div><section class="cards" id="report-cards"><article><span>Pull requests</span><strong>${r.pr_total}</strong><small>${r.state_counts.MERGED || 0} merged · ${r.state_counts.OPEN || 0} open · ${r.state_counts.DECLINED || 0} declined</small></article><article class="accent"><span>Human approvals</span><strong>${r.total_approvals}</strong><small>${humans.length} approvers</small></article><article><span>Top approver</span><strong>${escapeHtml(r.approvals[0]?.name || '—')}</strong><small>${r.approvals[0]?.approvals || 0} approvals</small></article></section><section class="tablewrap"><div class="tablehead"><h2>Approvals by person</h2><span>Sorted high to low · Jarvis excluded</span></div><table><thead><tr><th>RANK</th><th>REVIEWER</th><th></th><th>APPROVALS</th><th>SHARE OF HUMAN</th></tr></thead><tbody id="approval-rows">${rows || '<tr><td colspan="5" class="emptyrow">No approvals found for this period.</td></tr>'}</tbody></table></section><footer>Generated ${new Date(r.generated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</footer><script>const report=${JSON.stringify(r).replace(/</g, "\\u003c")};document.querySelectorAll('.repo-tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.repo-tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');const d=b.dataset.repo==='all'?report:{...report,...report.per_repo[Number(b.dataset.repo)]};const human=d.approvals.filter(x=>x.note!=='bot');const max=d.approvals[0]?.approvals||1;document.querySelector('#report-cards').innerHTML='<article><span>Pull requests</span><strong>'+d.pr_total+'</strong><small>'+(d.state_counts.MERGED||0)+' merged · '+(d.state_counts.OPEN||0)+' open · '+(d.state_counts.DECLINED||0)+' declined</small></article><article class="accent"><span>Human approvals</span><strong>'+d.total_approvals+'</strong><small>'+human.length+' approvers</small></article><article><span>Top approver</span><strong>'+escClient(d.approvals[0]?.name||'—')+'</strong><small>'+(d.approvals[0]?.approvals||0)+' approvals</small></article>';document.querySelector('#approval-rows').innerHTML=d.approvals.map((x,i)=>'<tr><td class="rank">'+String(i+1).padStart(2,'0')+'</td><td><span class="person">'+escClient(x.name)+'</span></td><td class="barcell"><span class="bar" style="width:'+Math.max(2,x.approvals/max*100)+'%"></span></td><td class="count">'+x.approvals+'</td><td class="share">'+(x.approvals/Math.max(1,human.reduce((n,y)=>n+y.approvals,0))*100).toFixed(1)+'%</td></tr>').join('')||'<tr><td colspan="5" class="emptyrow">No approvals found for this period.</td></tr>'}));function escClient(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}</script>`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function css() { return `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#edf2eb;background:#0b0e0d;line-height:1.45}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0%,#27352b 0,transparent 35%),#0b0e0d}main{max-width:1180px;margin:auto;padding:72px 28px 48px}.eyebrow,.label,th{font-size:12px;letter-spacing:.13em;font-weight:700;color:#9ba89e}.eyebrow{color:#d9ff57;margin-bottom:18px}h1{font-size:clamp(42px,7vw,82px);line-height:.98;letter-spacing:-.06em;margin:0;max-width:700px}.lede{color:#aab5aa;font-size:19px;margin:22px 0 54px}.context{border-top:1px solid #344137;border-bottom:1px solid #344137;padding:20px 0;display:grid;grid-template-columns:1fr 1fr auto;gap:24px;align-items:end}.label{display:block;margin-bottom:5px}.context strong{font-size:15px}.context strong span{color:#718071;padding:0 3px}.context a{color:#d9ff57;text-decoration:none;font-size:14px}.repo-tabs{display:flex;flex-wrap:wrap;gap:8px;padding:20px 0 4px}.repo-tab{border:1px solid #2d3930;background:#131915;color:#aab5aa;border-radius:999px;padding:8px 13px;font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}.repo-tab.active,.repo-tab.selected{background:#d9ff57;color:#0b0e0d;border-color:#d9ff57}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:24px 0 28px}.cards article{background:#131915;border:1px solid #2d3930;border-radius:16px;padding:22px;min-height:150px}.cards article.accent{background:#d9ff57;color:#0b0e0d;border-color:#d9ff57}.cards span,.cards small{display:block;font-size:14px;color:#9ba89e}.cards .accent span,.cards .accent small{color:#39452f}.cards strong{display:block;font-size:38px;letter-spacing:-.04em;margin:22px 0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tablewrap{background:#111612;border:1px solid #2d3930;border-radius:16px;overflow:hidden}.tablehead{display:flex;justify-content:space-between;align-items:center;padding:22px 24px;border-bottom:1px solid #2d3930}.tablehead h2{font-size:18px;margin:0}.tablehead span{font-size:13px;color:#718071}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:15px 18px;border-bottom:1px solid #263128}th{font-size:11px;padding-top:14px;padding-bottom:10px}tbody tr:last-child td{border:0}.rank{color:#718071;width:65px}.person{font-weight:650}.tag{color:#0b0e0d;background:#d9ff57;border-radius:4px;font-size:10px;font-weight:800;margin-left:8px;padding:3px 5px}.barcell{width:35%}.bar{display:block;height:8px;background:#d9ff57;border-radius:9px;min-width:4px}.count{font-variant-numeric:tabular-nums;font-weight:700;width:100px}.share{color:#aab5aa;width:130px}.empty,.emptyrow{text-align:center;color:#aab5aa}.empty{border:1px solid #2d3930;border-radius:16px;padding:64px 24px}.empty h2{color:#edf2eb}.empty button{border:0;border-radius:999px;background:#d9ff57;color:#0b0e0d;padding:13px 20px;font:inherit;font-weight:750;cursor:pointer}.empty button:disabled{opacity:.6;cursor:wait}.status{font-size:14px;min-height:20px}.loading-overlay{position:fixed;inset:0;z-index:20;display:grid;place-items:center;background:rgba(11,14,13,.96);padding:24px}.loading-overlay .loader{width:min(520px,100%);text-align:center;border:1px solid #2d3930;border-radius:20px;background:#111612;padding:36px}.loading-overlay .loader h2{font-size:24px;margin:0 0 10px}.loading-overlay .loader p{color:#9ba89e}.spinner{width:28px;height:28px;margin:0 auto 20px;border:3px solid #344137;border-top-color:#d9ff57;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}code{color:#d9ff57}footer{color:#718071;font-size:12px;margin-top:20px}@media(max-width:760px){main{padding:40px 16px}.context{grid-template-columns:1fr 1fr}.context a{grid-column:1/-1}.cards{grid-template-columns:1fr}.cards article{min-height:auto}.cards strong{margin-top:14px}.tablewrap{overflow-x:auto}table{min-width:680px}.lede{font-size:17px;margin-bottom:36px}}`; }

function appPage(theme) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TRUEID · BITBUCKET</title><style>${theme}
.months{padding:20px 0}.month-grid{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.month-grid label{border:1px solid #344137;border-radius:30px;padding:8px 12px}.month-grid input{accent-color:#d9ff57}button{cursor:pointer}.load-months{background:#d9ff57;border:0;border-radius:30px;padding:12px 20px;font:inherit}.progress{height:8px;background:#263128;border-radius:10px;overflow:hidden}.progress i{display:block;height:100%;background:#d9ff57;width:8%;transition:width .3s}.loading-overlay[hidden]{display:none}</style></head><body><main><header><div class="eyebrow">TRUEID · BITBUCKET</div><h1>Review approvals</h1></header><section class="months"><h2>Months to review</h2><div class="month-grid" id="months"></div><button class="load-months" id="load">Load selected months</button><p id="status" role="status"></p></section><div id="report"></div></main><div class="loading-overlay" id="loading"><div class="loader"><div class="spinner"></div><h2>Loading review activity</h2><p id="progress-copy">Loading the latest completed month…</p><div class="progress"><i id="progress"></i></div><p id="load-error"></p><button class="load-months" id="retry" hidden>Try again</button></div></div><script>(${client.toString()})();</script></body></html>`, {headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
}

function client() {
  const $ = id => document.getElementById(id);
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()-1,1)).toISOString().slice(0,7);
  const loaded = new Map();
  let reports = [], selectedRepos = new Set(), lastSelection = [previous];
  const esc = x => String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  for(let i=0;i<12;i++) {
    const m = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1)).toISOString().slice(0,7);
    $('months').insertAdjacentHTML('beforeend',`<label><input type="checkbox" value="${m}" ${m===previous?'checked':''}>${m}</label>`);
  }
  function draw() {
    const byRepo = new Map();
    for(const report of reports) for(const repo of report.per_repo) {
      const target=byRepo.get(repo.slug)||{slug:repo.slug,pr_total:0,state_counts:{MERGED:0,OPEN:0,DECLINED:0},people:new Map()};
      target.pr_total+=repo.pr_total;
      for(const state of Object.keys(target.state_counts)) target.state_counts[state]+=repo.state_counts[state]||0;
      for(const person of repo.approvals){const key=person.uuid||person.name;const old=target.people.get(key)||{...person,approvals:0};old.approvals+=person.approvals;target.people.set(key,old);}
      byRepo.set(repo.slug,target);
    }
    const included=[...byRepo.values()].filter(r=>!selectedRepos.size||selectedRepos.has(r.slug));
    const people=new Map();let count=0;
    for(const repo of included){count+=repo.pr_total;for(const [key,p] of repo.people){const old=people.get(key)||{...p,approvals:0};old.approvals+=p.approvals;people.set(key,old);}}
    const rows=[...people.values()].sort((a,b)=>b.approvals-a.approvals);
    const total=rows.reduce((sum,p)=>sum+p.approvals,0);
    $('report').innerHTML=`<section class="context"><div><span class="label">REPORTING MONTHS</span><strong>${reports.map(r=>r.since.slice(0,7)).sort().join(', ')}</strong></div><div><span class="label">SCOPE</span><strong>${included.length} repositories</strong></div></section><div class="repo-tabs"><button class="repo-tab ${selectedRepos.size?'':'active'}" data-repo="">All repos</button>${[...byRepo.keys()].map(slug=>`<button class="repo-tab ${selectedRepos.has(slug)?'active':''}" data-repo="${esc(slug)}">${esc(slug)}</button>`).join('')}</div><section class="cards"><article><span>Pull requests</span><strong>${count}</strong></article><article class="accent"><span>Human approvals</span><strong>${total}</strong><small>${rows.length} approvers</small></article><article><span>Top approver</span><strong>${esc(rows[0]?.name||'—')}</strong><small>Jarvis excluded</small></article></section><section class="tablewrap"><div class="tablehead"><h2>Approvals by person</h2></div><table><thead><tr><th>RANK</th><th>REVIEWER</th><th>APPROVALS</th></tr></thead><tbody>${rows.map((p,i)=>`<tr><td>${i+1}</td><td>${esc(p.name)}</td><td>${p.approvals}</td></tr>`).join('')}</tbody></table></section>`;
    $('report').querySelectorAll('[data-repo]').forEach(b=>b.onclick=()=>{const slug=b.dataset.repo;if(!slug)selectedRepos.clear();else if(selectedRepos.has(slug))selectedRepos.delete(slug);else selectedRepos.add(slug);draw();});
  }
  async function load(months) {
    if(!months.length){$('status').textContent='Select at least one month.';return;}
    lastSelection=months;$('loading').hidden=false;$('retry').hidden=true;$('load-error').textContent='';$('load').disabled=true;
    let progress=8;const timer=setInterval(()=>{$('progress').style.width=(progress=Math.min(92,progress+1))+'%';},1000);
    try {
      const results=[];
      for(let i=0;i<months.length;i++) {
        const m=months[i];$('progress-copy').textContent=`Loading ${m} (${i+1}/${months.length})…`;
        if(!loaded.has(m)) {
          const response=await fetch('/api/'+m);
          const report=await response.json();
          if(!response.ok||!Array.isArray(report.per_repo))throw new Error(report.error||'Could not load '+m);
          loaded.set(m,report);
        }
        results.push(loaded.get(m));
      }
      reports=results;selectedRepos.clear();draw();$('progress').style.width='100%';$('loading').hidden=true;$('status').textContent='Loaded '+months.join(', ');
    } catch(error) {$('load-error').textContent=error.message;$('retry').hidden=false;}
    finally {clearInterval(timer);$('load').disabled=false;}
  }
  $('load').onclick=()=>load([...$('months').querySelectorAll('input:checked')].map(x=>x.value));
  $('retry').onclick=()=>load(lastSelection);
  load([previous]);
}
