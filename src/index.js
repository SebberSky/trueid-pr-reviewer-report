import { appPage } from "./ui.js";
const STATES = ["MERGED", "OPEN", "DECLINED"];
const FIELDS = [
  "values.id",
  "values.state",
  "values.updated_on",
  "values.participants.user.display_name",
  "values.participants.user.nickname",
  "values.participants.user.uuid",
  "values.participants.approved",
  "values.participants.role",
  "next",
  "size",
].join(",");
let LAST_REPORT = null;
const IN_FLIGHT = new Map();
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

function reusableReport(report, since, until) {
  const generated = Date.parse(report.generated_at);
  const end = Date.parse(until + "T00:00:00Z") + 86400000;
  if (end <= Date.now()) return generated >= end;
  return report.since === since && Date.now() - generated < REFRESH_COOLDOWN_MS;
}

function storageEnvironment(env) {
  if (env.STATS || !env.REPORTS) return env;
  return {
    ...env,
    STATS: {
      get: async (key) => {
        const object = await env.REPORTS.get(key);
        return object ? object.text() : null;
      },
      put: (key, value) => env.REPORTS.put(key, value),
      delete: (key) => env.REPORTS.delete(key),
      list: async (options) => {
        const result = await env.REPORTS.list(options);
        return { keys: result.objects.map((object) => ({ name: object.key })) };
      },
    },
  };
}

export default {
  async scheduled(event, env, ctx) {
    env = storageEnvironment(env);
    const { since, until } = previousMonth(
      new Date(event.scheduledTime || Date.now()),
    );
    ctx.waitUntil(runAndStore(env, since, until));
  },
  async fetch(request, env, ctx) {
    env = storageEnvironment(env);
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/run") {
        if (
          !env.RUN_SECRET ||
          request.headers.get("x-run-secret") !== env.RUN_SECRET
        ) {
          return json({ error: "Unauthorized" }, 401);
        }
        const { since, until } = previousMonth(new Date());
        const result = await runAndStore(env, since, until);
        return json(result);
      }
      if (request.method === "GET" && url.pathname === "/api/latest") {
        const latest =
          url.searchParams.get("refresh") === "1"
            ? await runAndStore(
                env,
                previousMonth(new Date()).since,
                previousMonth(new Date()).until,
              )
            : await getLatest(env);
        return latest
          ? json(latest)
          : json({ error: "No report has been generated yet" }, 404);
      }
      const month = url.pathname.match(/^\/api\/(\d{4}-\d{2})$/)?.[1];
      if (request.method === "GET" && month) {
        const { since, until } = monthWindow(month);
        const stored = env.STATS ? await env.STATS.get(`stats:${month}`) : null;
        if (stored) {
          const report = JSON.parse(stored);
          if (reusableReport(report, since, until)) return json(report);
        }
        return json(await runAndStore(env, since, until));
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        return appPage(css());
      }
      if (request.method === "GET" && url.pathname === "/report") {
        return appPage(css());
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Worker error");
      return json(
        {
          error:
            error.message === "Month outside available reporting period"
              ? error.message
              : "Unable to complete request",
        },
        error.message === "Month outside available reporting period"
          ? 400
          : 500,
      );
    }
  },
};

async function runAndStore(env, since, until) {
  const month = since.slice(0, 7);
  const key = `stats:${month}`;
  const existing = IN_FLIGHT.get(key);
  if (existing) return existing;
  const cached = env.STATS ? await env.STATS.get(key) : null;
  if (cached) {
    const report = JSON.parse(cached);
    if (reusableReport(report, since, until)) {
      LAST_REPORT = report;
      return report;
    }
  }
  const pending = IN_FLIGHT.get(key);
  if (pending) return pending;
  const job = (async () => {
    try {
      const report = await collect(env, since, until);
      LAST_REPORT = report;
      if (env.STATS) {
        await env.STATS.put(key, JSON.stringify(report));
        await env.STATS.put("stats:latest", JSON.stringify(report));
        const entries = env.STATS.list
          ? await env.STATS.list({ prefix: "stats:" })
          : null;
        const months = entries
          ? entries.keys
              .map((entry) => entry.name.slice(6))
              .filter((value) => /^\d{4}-\d{2}$/.test(value))
          : JSON.parse((await env.STATS.get("stats:months")) || "[]");
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
    if (stored && reusableReport(JSON.parse(stored), since, until))
      return JSON.parse(stored);
  }
  if (LAST_REPORT?.since === since && reusableReport(LAST_REPORT, since, until))
    return LAST_REPORT;
  try {
    return await runAndStore(env, since, until);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unable to load latest report",
    );
    return null;
  }
}

async function collectRepository(env, repo, auth, since, until) {
  const repoSeen = new Map();
  const repoCounts = { MERGED: 0, OPEN: 0, DECLINED: 0 };
  for (const state of STATES) {
    const endExclusive = new Date(
      new Date(until + "T00:00:00Z").getTime() + 86400000,
    )
      .toISOString()
      .slice(0, 10);
    let next = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(env.BITBUCKET_WORKSPACE)}/${encodeURIComponent(repo)}/pullrequests?q=${encodeURIComponent(`state="${state}" AND updated_on>="${since}" AND updated_on<"${endExclusive}"`)}&sort=-updated_on&pagelen=50&fields=${encodeURIComponent(FIELDS)}`;
    while (next) {
      const response = await fetch(next, {
        signal: AbortSignal.timeout(120000),
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });
      if (!response.ok)
        throw new Error(
          `Bitbucket API returned ${response.status} for ${repo}`,
        );
      const page = await response.json();
      for (const pr of page.values || []) {
        if (!pr.id || repoSeen.has(pr.id)) continue;
        if (
          !pr.updated_on ||
          (pr.updated_on.slice(0, 10) >= since &&
            pr.updated_on.slice(0, 10) <= until)
        ) {
          repoSeen.set(pr.id, pr);
          repoCounts[pr.state] = (repoCounts[pr.state] || 0) + 1;
        }
      }
      const oldest = page.values?.at(-1)?.updated_on?.slice(0, 10);
      next = oldest && oldest < since ? null : page.next || null;
    }
  }
  return { repo, repoSeen, repoCounts };
}

async function collect(env, since, until) {
  const repos = (env.BITBUCKET_REPO_SLUGS || env.BITBUCKET_REPO_SLUG || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!repos.length) throw new Error("No Bitbucket repositories configured");
  const auth = btoa(`${env.BITBUCKET_USERNAME}:${env.BITBUCKET_APP_PASSWORD}`);
  const seen = new Map();
  const stateCounts = { MERGED: 0, OPEN: 0, DECLINED: 0 };
  const people = new Map();
  const repoResults = await Promise.all(
    repos.map((repo) => collectRepository(env, repo, auth, since, until)),
  );
  for (const { repo, repoSeen, repoCounts } of repoResults) {
    for (const [state, count] of Object.entries(repoCounts))
      stateCounts[state] += count;
    for (const [id, pr] of repoSeen)
      seen.set(`${repo}:${id}`, { ...pr, _repo: repo });
    for (const pr of repoSeen.values()) {
      for (const participant of pr.participants || []) {
        if (!participant.approved || !participant.user) continue;
        const user = participant.user;
        const name = user.display_name || user.nickname || "Unknown";
        if (/jarvis/i.test(name)) continue;
        const key = user.uuid || user.nickname || user.display_name;
        const current = people.get(key) || {
          name,
          uuid: user.uuid || null,
          approvals: 0,
          note: null,
        };
        current.approvals += 1;
        people.set(key, current);
      }
    }
  }
  const approvals = [...people.values()].sort(
    (a, b) => b.approvals - a.approvals || a.name.localeCompare(b.name),
  );
  const per_repo = repos.map((slug) => {
    const prs = [...seen.values()].filter((pr) => pr._repo === slug);
    const p = new Map();
    for (const pr of prs)
      for (const participant of pr.participants || []) {
        const name =
          participant.user?.display_name ||
          participant.user?.nickname ||
          "Unknown";
        if (!participant.approved || !participant.user || /jarvis/i.test(name))
          continue;
        const key = participant.user.uuid || participant.user.nickname || name;
        const current = p.get(key) || {
          name,
          uuid: participant.user.uuid || null,
          approvals: 0,
          note: null,
        };
        current.approvals += 1;
        p.set(key, current);
      }
    const a = [...p.values()].sort(
      (x, y) => y.approvals - x.approvals || x.name.localeCompare(y.name),
    );
    const states = { MERGED: 0, OPEN: 0, DECLINED: 0 };
    prs.forEach((pr) => (states[pr.state] = (states[pr.state] || 0) + 1));
    return {
      slug,
      pr_total: prs.length,
      state_counts: states,
      total_approvals: a.reduce((n, x) => n + x.approvals, 0),
      approvals: a,
    };
  });
  return {
    repos: repos.map((repo) => `${env.BITBUCKET_WORKSPACE}/${repo}`),
    per_repo,
    repo: `${env.BITBUCKET_WORKSPACE} · ${repos.length} repositories`,
    since,
    until,
    pr_total: seen.size,
    state_counts: stateCounts,
    total_approvals: approvals.reduce((n, x) => n + x.approvals, 0),
    approvals,
    generated_at: new Date().toISOString(),
  };
}

function previousMonth(date) {
  const first = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1),
  );
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
  return {
    since: first.toISOString().slice(0, 10),
    until: last.toISOString().slice(0, 10),
  };
}

function monthWindow(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error("Invalid month");
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const earliest = new Date();
  earliest.setUTCDate(1);
  earliest.setUTCMonth(earliest.getUTCMonth() - 11);
  if (
    index < 0 ||
    index > 11 ||
    month > currentMonth ||
    month < earliest.toISOString().slice(0, 7)
  )
    throw new Error("Month outside available reporting period");
  const first = new Date(Date.UTC(year, index, 1));
  const next = new Date(Date.UTC(year, index + 1, 1));
  const current = new Date();
  const isCurrent =
    year === current.getUTCFullYear() && index === current.getUTCMonth();
  const last = isCurrent ? current : new Date(next.getTime() - 86400000);
  return {
    since: first.toISOString().slice(0, 10),
    until: last.toISOString().slice(0, 10),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function css() {
  return `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#edf2eb;background:#0b0e0d;line-height:1.45}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0%,#27352b 0,transparent 35%),#0b0e0d}main{max-width:1180px;margin:auto;padding:72px 28px 48px}.eyebrow,.label,th{font-size:12px;letter-spacing:.13em;font-weight:700;color:#9ba89e}.eyebrow{color:#d9ff57;margin-bottom:18px}h1{font-size:clamp(42px,7vw,82px);line-height:.98;letter-spacing:-.06em;margin:0;max-width:700px}.lede{color:#aab5aa;font-size:19px;margin:22px 0 54px}.context{border-top:1px solid #344137;border-bottom:1px solid #344137;padding:20px 0;display:grid;grid-template-columns:1fr 1fr auto;gap:24px;align-items:end}.label{display:block;margin-bottom:5px}.context strong{font-size:15px}.context strong span{color:#718071;padding:0 3px}.context a{color:#d9ff57;text-decoration:none;font-size:14px}.repo-tabs{display:flex;flex-wrap:wrap;gap:8px;padding:20px 0 4px}.repo-tab{border:1px solid #2d3930;background:#131915;color:#aab5aa;border-radius:999px;padding:8px 13px;font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}.repo-tab.active,.repo-tab.selected{background:#d9ff57;color:#0b0e0d;border-color:#d9ff57}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:24px 0 28px}.cards article{background:#131915;border:1px solid #2d3930;border-radius:16px;padding:22px;min-height:150px}.cards article.accent{background:#d9ff57;color:#0b0e0d;border-color:#d9ff57}.cards span,.cards small{display:block;font-size:14px;color:#9ba89e}.cards .accent span,.cards .accent small{color:#39452f}.cards strong{display:block;font-size:38px;letter-spacing:-.04em;margin:22px 0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tablewrap{background:#111612;border:1px solid #2d3930;border-radius:16px;overflow:hidden}.tablehead{display:flex;justify-content:space-between;align-items:center;padding:22px 24px;border-bottom:1px solid #2d3930}.tablehead h2{font-size:18px;margin:0}.tablehead span{font-size:13px;color:#718071}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:15px 18px;border-bottom:1px solid #263128}th{font-size:11px;padding-top:14px;padding-bottom:10px}tbody tr:last-child td{border:0}.rank{color:#718071;width:65px}.person{font-weight:650}.tag{color:#0b0e0d;background:#d9ff57;border-radius:4px;font-size:10px;font-weight:800;margin-left:8px;padding:3px 5px}.barcell{width:35%}.bar{display:block;height:8px;background:#d9ff57;border-radius:9px;min-width:4px}.count{font-variant-numeric:tabular-nums;font-weight:700;width:100px}.share{color:#aab5aa;width:130px}.empty,.emptyrow{text-align:center;color:#aab5aa}.empty{border:1px solid #2d3930;border-radius:16px;padding:64px 24px}.empty h2{color:#edf2eb}.empty button{border:0;border-radius:999px;background:#d9ff57;color:#0b0e0d;padding:13px 20px;font:inherit;font-weight:750;cursor:pointer}.empty button:disabled{opacity:.6;cursor:wait}.status{font-size:14px;min-height:20px}.loading-overlay{position:fixed;inset:0;z-index:20;display:grid;place-items:center;background:rgba(11,14,13,.96);padding:24px}.loading-overlay .loader{width:min(520px,100%);text-align:center;border:1px solid #2d3930;border-radius:20px;background:#111612;padding:36px}.loading-overlay .loader h2{font-size:24px;margin:0 0 10px}.loading-overlay .loader p{color:#9ba89e}.spinner{width:28px;height:28px;margin:0 auto 20px;border:3px solid #344137;border-top-color:#d9ff57;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}code{color:#d9ff57}footer{color:#718071;font-size:12px;margin-top:20px}@media(max-width:760px){main{padding:40px 16px}.context{grid-template-columns:1fr 1fr}.context a{grid-column:1/-1}.cards{grid-template-columns:1fr}.cards article{min-height:auto}.cards strong{margin-top:14px}.tablewrap{overflow-x:auto}table{min-width:680px}.lede{font-size:17px;margin-bottom:36px}}`;
}
