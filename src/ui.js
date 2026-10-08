export function appPage(theme) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TRUEID · BITBUCKET</title><style>${theme}
.months{padding:20px 0}.month-grid{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.month-grid label{border:1px solid #344137;border-radius:30px;padding:8px 12px}.month-grid input{accent-color:#d9ff57}button{cursor:pointer}.load-months{background:#d9ff57;border:0;border-radius:30px;padding:12px 20px;font:inherit}.progress{height:8px;background:#263128;border-radius:10px;overflow:hidden}.progress i{display:block;height:100%;background:#d9ff57;width:8%;transition:width .3s}.loading-overlay[hidden]{display:none}</style></head><body><main><header><div class="eyebrow">TRUEID · BITBUCKET</div><h1>Review approvals</h1></header><section class="months"><h2>Months to review</h2><div class="month-grid" id="months"></div><button class="load-months" id="load">Load selected months</button><p id="status" role="status"></p></section><div id="report"></div></main><div class="loading-overlay" id="loading"><div class="loader"><div class="spinner"></div><h2>Loading review activity</h2><p id="progress-copy">Loading the latest completed month…</p><div class="progress"><i id="progress"></i></div><p id="load-error"></p><button class="load-months" id="retry" hidden>Try again</button></div></div><script>(${client.toString()})();</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function client() {
  const $ = (id) => document.getElementById(id);
  const now = new Date();
  const previous = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  )
    .toISOString()
    .slice(0, 7);
  const loaded = new Map();
  let reports = [],
    selectedRepos = new Set(),
    lastSelection = [previous];
  const esc = (x) =>
    String(x).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  for (let i = 0; i < 12; i++) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      .toISOString()
      .slice(0, 7);
    $("months").insertAdjacentHTML(
      "beforeend",
      `<label><input type="checkbox" value="${m}" ${m === previous ? "checked" : ""}>${m}</label>`,
    );
  }
  function draw() {
    const byRepo = new Map();
    for (const report of reports)
      for (const repo of report.per_repo) {
        const target = byRepo.get(repo.slug) || {
          slug: repo.slug,
          pr_total: 0,
          state_counts: { MERGED: 0, OPEN: 0, DECLINED: 0 },
          people: new Map(),
        };
        target.pr_total += repo.pr_total;
        for (const state of Object.keys(target.state_counts))
          target.state_counts[state] += repo.state_counts[state] || 0;
        for (const person of repo.approvals) {
          const key = person.uuid || person.name;
          const old = target.people.get(key) || { ...person, approvals: 0 };
          old.approvals += person.approvals;
          target.people.set(key, old);
        }
        byRepo.set(repo.slug, target);
      }
    const included = [...byRepo.values()].filter(
      (r) => !selectedRepos.size || selectedRepos.has(r.slug),
    );
    const people = new Map();
    let count = 0;
    for (const repo of included) {
      count += repo.pr_total;
      for (const [key, p] of repo.people) {
        const old = people.get(key) || { ...p, approvals: 0 };
        old.approvals += p.approvals;
        people.set(key, old);
      }
    }
    const rows = [...people.values()].sort((a, b) => b.approvals - a.approvals);
    const total = rows.reduce((sum, p) => sum + p.approvals, 0);
    $("report").innerHTML =
      `<section class="context"><div><span class="label">REPORTING MONTHS</span><strong>${reports
        .map((r) => r.since.slice(0, 7))
        .sort()
        .join(
          ", ",
        )}</strong></div><div><span class="label">SCOPE</span><strong>${included.length} repositories</strong></div></section><div class="repo-tabs"><button class="repo-tab ${selectedRepos.size ? "" : "active"}" data-repo="">All repos</button>${[...byRepo.keys()].map((slug) => `<button class="repo-tab ${selectedRepos.has(slug) ? "active" : ""}" data-repo="${esc(slug)}">${esc(slug)}</button>`).join("")}</div><section class="cards"><article><span>Pull requests</span><strong>${count}</strong></article><article class="accent"><span>Human approvals</span><strong>${total}</strong><small>${rows.length} approvers</small></article><article><span>Top approver</span><strong>${esc(rows[0]?.name || "—")}</strong><small>Jarvis excluded</small></article></section><section class="tablewrap"><div class="tablehead"><h2>Approvals by person</h2></div><table><thead><tr><th>RANK</th><th>REVIEWER</th><th aria-label="Approval comparison"></th><th>APPROVALS</th></tr></thead><tbody>${rows.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td class="barcell"><span class="bar" style="width:${Math.max(2, (p.approvals / Math.max(1, rows[0]?.approvals || 0)) * 100)}%"></span></td><td class="count">${p.approvals}</td></tr>`).join("")}</tbody></table></section>`;
    $("report")
      .querySelectorAll("[data-repo]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const slug = b.dataset.repo;
            if (!slug) selectedRepos.clear();
            else if (selectedRepos.has(slug)) selectedRepos.delete(slug);
            else selectedRepos.add(slug);
            draw();
          }),
      );
  }
  async function load(months) {
    if (!months.length) {
      $("status").textContent = "Select at least one month.";
      return;
    }
    lastSelection = months;
    $("loading").hidden = false;
    $("retry").hidden = true;
    $("load-error").textContent = "";
    $("load").disabled = true;
    let progress = 8;
    const timer = setInterval(() => {
      $("progress").style.width = (progress = Math.min(92, progress + 1)) + "%";
    }, 1000);
    try {
      const results = [];
      for (let i = 0; i < months.length; i++) {
        const m = months[i];
        $("progress-copy").textContent =
          `Loading ${m} (${i + 1}/${months.length})…`;
        const cached = loaded.get(m);
        const [year, month] = m.split("-").map(Number);
        const exclusiveEnd = Date.UTC(year, month, 1);
        if (
          !cached ||
          (exclusiveEnd <= Date.now() &&
            Date.parse(cached.generated_at) < exclusiveEnd) ||
          (m === now.toISOString().slice(0, 7) &&
            Date.now() - Date.parse(cached.generated_at) >= 300000)
        ) {
          const response = await fetch("/api/" + m, {
            signal: AbortSignal.timeout(180000),
          });
          const report = await response.json();
          if (!response.ok || !Array.isArray(report.per_repo))
            throw new Error(report.error || "Could not load " + m);
          loaded.set(m, report);
        }
        results.push(loaded.get(m));
      }
      reports = results;
      selectedRepos.clear();
      draw();
      $("progress").style.width = "100%";
      $("loading").hidden = true;
      $("status").textContent = "Loaded " + months.join(", ");
    } catch (error) {
      $("load-error").textContent = error.message;
      $("retry").hidden = false;
    } finally {
      clearInterval(timer);
      $("load").disabled = false;
    }
  }
  $("load").onclick = () =>
    load(
      [...$("months").querySelectorAll("input:checked")].map((x) => x.value),
    );
  $("retry").onclick = () => load(lastSelection);
  load([previous]);
}
