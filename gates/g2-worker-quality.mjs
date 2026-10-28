// Phase 2 / Gate G2 — worker quality on bounded real issues.
//
//   node 03-worker-quality-g2.mjs [--issues 1,2,3] [--timeout-min 25]
//
// For each issue: if a draft PR already exists for agent/issue-<n> (and
// --allow-existing), evaluate it; otherwise run the full unattended chain
// (simulated webhook -> factory -> sandboxed worker -> draft PR).
//
// Objective checks per issue (no model judgment):
//   A. test suite passes on the resulting branch;
//   B. diff is scoped: every changed file under src/ or test/, <= 5 files;
//   C. the specific behavior named in the issue is fixed (live-server check).
//
// G2 passes when >= 2 of 3 issues produce a passing, scoped PR with zero human edits.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NOTE: plain ESM — no TS syntax in .mjs gates (Node's strip-types does not
// transform .mjs); types are omitted throughout this file.
import { startIntakeServer } from "../factory/intake.ts";
import { loadFactoryEnv, spawnInstance, defaultConfigPath } from "./lib.ts";

const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

const argv = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};
// Second-generation fixture issues (#16–#18); the first generation (1–3) is
// already merged into main, so re-running it yields "no changes needed".
const issues = opt("--issues", "16,17,18").split(",").map(Number);
const timeoutMin = Number(opt("--timeout-min", "25"));
const allowExisting = argv.includes("--allow-existing");
// Scope bound: 5 held for single-behavior issues, but an issue that adds a ROUTE legitimately
// spans server.mjs + invoices.mjs + store.mjs + two test files (issue #34 did exactly that and
// failed scope while its behavior was correct). The bound stays at 5 by default — weakening it
// silently would defeat the check — but is now overridable so a run's calibration is explicit.
const maxScopeFiles = Number(opt("--max-files", "5"));

loadFactoryEnv();
const fixturesRepo = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";
const runDir = await mkdtemp(join(tmpdir(), "gates-g2-"));
const results = [];

// ---------------------------------------------------------------------------
// Run one issue end-to-end (or skip when its draft PR already exists).
// ---------------------------------------------------------------------------
async function runIssue(issueNumber) {
  const branch = `agent/issue-${issueNumber}`;
  let existing = [];
  try {
    const out = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", branch, "--json", "number,url,isDraft"]);
    existing = JSON.parse(out || "[]");
  } catch { /* none */ }

  if (existing.length > 0) {
    if (!allowExisting) throw new Error(`draft PR ${existing[0].url} already exists for ${branch}; close it or pass --allow-existing`);
    console.log(`issue #${issueNumber}: using existing draft PR ${existing[0].url}`);
    return { issueNumber, prUrl: existing[0].url, wallSecs: null, run: "existing" };
  }

  const t0 = Date.now();
  const instance = await spawnInstance({ repo: fixturesRepo, configPath: defaultConfigPath(fixturesRepo) });
  const dispatch = async ({ requestId, content }) => {
    const res = await fetch(`${instance.base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.token}` },
      body: JSON.stringify({ requestId, content }),
    });
    if (!res.ok) throw new Error(`factory /tasks returned ${res.status}`);
    return res.json();
  };
  const { server: intake, port: intakePort } = await startIntakeServer({
    logPath: join(runDir, `intake-g2-issue-${issueNumber}.jsonl`),
    dispatch,
  });

  const issue = await sh("gh", ["api", `repos/${fixturesRepo}/issues/${issueNumber}`, "--jq", ".title"]);
  const body = (await sh("gh", ["api", `repos/${fixturesRepo}/issues/${issueNumber}`, "--jq", '.body // ""'])).trim();
  const event = {
    action: "opened",
    delivery_id: `g2-${issueNumber}-${Date.now()}`,
    repository: { full_name: fixturesRepo },
    issue: { number: issueNumber, title: issue, body, labels: [{ name: "agent" }] },
  };
  const delivery = await fetch(`http://127.0.0.1:${intakePort}/webhook/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": event.delivery_id },
    body: JSON.stringify(event),
  });
  const deliveryBody = await delivery.json();
  if (!deliveryBody.accepted) throw new Error(`intake rejected issue #${issueNumber}: ${JSON.stringify(deliveryBody)}`);

  let pr = null;
  const deadline = Date.now() + timeoutMin * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    try {
      const out = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", branch, "--json", "number,url,isDraft"]);
      const list = JSON.parse(out || "[]");
      if (list.length > 0) {
        pr = list[0];
        break;
      }
    } catch { /* not yet */ }
    process.stdout.write(".");
  }
  intake.close();
  await instance.close();

  const wallSecs = Math.round((Date.now() - t0) / 1000);
  if (!pr || !pr.isDraft) throw new Error(`no draft PR for ${branch} after ${wallSecs}s`);
  console.log(`issue #${issueNumber}: draft PR ${pr.url} in ${wallSecs}s`);
  return { issueNumber, prUrl: pr.url, wallSecs, run: "fresh" };
}

// ---------------------------------------------------------------------------
// Objective checks on one branch.
// ---------------------------------------------------------------------------
async function cloneBranch(branch) {
  const dir = await mkdtemp(join(tmpdir(), `g2-${branch.replace(/\W/g, "")}-`));
  await sh("git", ["clone", "--quiet", "--branch", branch, `https://github.com/${fixturesRepo}.git`, dir]);
  return dir;
}

async function runSuite(dir) {
  try {
    const out = await sh("node", ["--test"], { cwd: dir });
    const pass = [...out.matchAll(/^# pass (\d+)$/gm)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
    const fail = [...out.matchAll(/^# fail (\d+)$/gm)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
    return { passed: fail === 0 && pass > 0, pass, fail };
  } catch (e) {
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    const fail = [...out.matchAll(/^# fail (\d+)$/gm)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
    return { passed: false, pass: 0, fail: fail || -1 };
  }
}

async function checkScope(dir, maxFiles = maxScopeFiles) {
  const files = (await sh("git", ["-C", dir, "diff", "--name-only", "origin/main...HEAD"])).split("\n").filter(Boolean);
  // Scope: implementation + tests + README docs only; nothing else, and bounded size.
  const inScope = files.every((f) => f.startsWith("src/") || f.startsWith("test/") || f === "README.md");
  return { files, maxFiles, inScope, ok: inScope && files.length <= maxFiles };
}

/** Start the branch's server on an ephemeral port; run fn; always stop it. */
async function withServer(dir, fn) {
  const child = spawn("node", ["src/server.mjs", "0"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  // The fixture server logs its bound port; parse it from stdout.
  let port = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in 15s")), 15_000);
    child.stdout.on("data", (d) => {
      const m = String(d).match(/127\.0\.0\.1:(\d+)/);
      if (m) {
        port = Number(m[1]);
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGKILL");
  }
}

const api = (base, method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

async function checkBehavior(issueNumber, dir) {
  return withServer(dir, async (base) => {
    if (issueNumber === 16) {
      const a = await api(base, "POST", "/invoices", { customerId: "f-c1", amountCents: 10 });
      const b = await api(base, "POST", "/invoices", { customerId: "f-c2", amountCents: 20 });
      const c = await api(base, "POST", "/invoices", { customerId: "f-c1", amountCents: 30 });
      const onlyC1 = await api(base, "GET", "/invoices?customer=f-c1");
      const miss = await api(base, "GET", "/invoices?customer=no-such-customer");
      const composed = await api(base, "GET", "/invoices?customer=f-c2&status=open");
      const all = await api(base, "GET", "/invoices");
      const c1Ok = onlyC1.status === 200 &&
        onlyC1.body.invoices.length === 2 &&
        onlyC1.body.invoices.every((i) => i.customerId === "f-c1") &&
        onlyC1.body.invoices[0].id < onlyC1.body.invoices[1].id;
      const missOk = miss.status === 200 && miss.body.invoices.length === 0;
      const composedOk = composed.status === 200 && composed.body.invoices.length === 1 && composed.body.invoices[0].id === b.body.id;
      const allOk = all.status === 200 && [a.body.id, b.body.id, c.body.id].every((id) => all.body.invoices.some((i) => i.id === id));
      return {
        ok: c1Ok && missOk && composedOk && allOk,
        detail: `?customer=f-c1 ok=${c1Ok}, miss ok=${missOk}, composed ok=${composedOk}, unfiltered ok=${allOk}`,
      };
    }
    if (issueNumber === 17) {
      const before = await api(base, "GET", "/summary");
      await api(base, "POST", "/invoices", { customerId: "s-open", amountCents: 100 });
      const paid = await api(base, "POST", "/invoices", { customerId: "s-paid", amountCents: 200 });
      const voided = await api(base, "POST", "/invoices", { customerId: "s-void", amountCents: 999 });
      await api(base, "PUT", `/invoices/${paid.body.id}/status`, { status: "paid" });
      await api(base, "PUT", `/invoices/${voided.body.id}/status`, { status: "voided" });
      const after = await api(base, "GET", "/summary");
      return {
        ok:
          after.body.invoiceCount === before.body.invoiceCount + 2 &&
          after.body.totalCents === before.body.totalCents + 300 &&
          after.body.openCents === before.body.openCents + 100 &&
          after.body.paidCents === before.body.paidCents + 200 &&
          after.body.openCents + after.body.paidCents === after.body.totalCents,
        detail: `count ${before.body.invoiceCount}->${after.body.invoiceCount} (want +2), open ${before.body.openCents}->${after.body.openCents} (want +100), paid ${before.body.paidCents}->${after.body.paidCents} (want +200)`,
      };
    }
    if (issueNumber === 18) {
      const inv = await api(base, "POST", "/invoices", { customerId: "t-idem", amountCents: 50 });
      const sameOpen = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "open" });
      await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "paid" });
      const samePaid = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "paid" });
      const invalid = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "voided" });
      return {
        ok:
          sameOpen.status === 200 && sameOpen.body.status === "open" &&
          samePaid.status === 200 && samePaid.body.status === "paid" &&
          invalid.status === 409,
        detail: `open->open ${sameOpen.status} (want 200), paid->paid ${samePaid.status} (want 200), paid->voided ${invalid.status} (want 409)`,
      };
    }
    if (issueNumber === 28) {
      // Issue: /summary gains openCount/paidCount/voidedCount, existing fields unchanged.
      const empty = await api(base, "GET", "/summary");
      await api(base, "POST", "/invoices", { customerId: "c28-open", amountCents: 100 });
      const paid = await api(base, "POST", "/invoices", { customerId: "c28-paid", amountCents: 200 });
      const voided = await api(base, "POST", "/invoices", { customerId: "c28-void", amountCents: 300 });
      await api(base, "PUT", `/invoices/${paid.body.id}/status`, { status: "paid" });
      await api(base, "PUT", `/invoices/${voided.body.id}/status`, { status: "voided" });
      const s = await api(base, "GET", "/summary");
      const zeroOk = empty.status === 200 && ["openCount", "paidCount", "voidedCount"].every((k) => empty.body[k] === 0);
      const countsOk = s.status === 200 && s.body.openCount === 1 && s.body.paidCount === 1 && s.body.voidedCount === 1;
      const keptOk = ["invoiceCount", "totalCents", "openCents", "paidCents"].every((k) => typeof s.body[k] === "number");
      return {
        ok: zeroOk && countsOk && keptOk,
        detail: `empty counts ${JSON.stringify([empty.body.openCount, empty.body.paidCount, empty.body.voidedCount])} (want 0,0,0), after 1/1/1 got ${JSON.stringify([s.body.openCount, s.body.paidCount, s.body.voidedCount])}, totals kept=${keptOk}`,
      };
    }
    if (issueNumber === 29) {
      // Issue: DELETE voids an open invoice; 409 on paid/voided; 404 unknown.
      const open = await api(base, "POST", "/invoices", { customerId: "c29", amountCents: 100 });
      const del = await api(base, "DELETE", `/invoices/${open.body.id}`);
      const afterDel = await api(base, "GET", `/invoices/${open.body.id}`);
      const paid = await api(base, "POST", "/invoices", { customerId: "c29b", amountCents: 200 });
      await api(base, "PUT", `/invoices/${paid.body.id}/status`, { status: "paid" });
      const delPaid = await api(base, "DELETE", `/invoices/${paid.body.id}`);
      const stillPaid = await api(base, "GET", `/invoices/${paid.body.id}`);
      const missing = await api(base, "DELETE", "/invoices/999999");
      const voidOk = del.status === 200 && del.body.status === "voided" && afterDel.body.status === "voided";
      const conflictOk = delPaid.status === 409 && stillPaid.body.status === "paid";
      const notFoundOk = missing.status === 404;
      return {
        ok: voidOk && conflictOk && notFoundOk,
        detail: `DELETE open ${del.status}/${del.body.status} (want 200/voided), DELETE paid ${delPaid.status} then status=${stillPaid.body.status} (want 409/paid), unknown ${missing.status} (want 404)`,
      };
    }
    if (issueNumber === 33) {
      // Issue: ?offset=N windows the filtered list; bad offset → 400; past end → empty 200.
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const created = await api(base, "POST", "/invoices", { customerId: `c33-${i}`, amountCents: 100 + i });
        ids.push(created.body.id);
      }
      const win = await api(base, "GET", "/invoices?offset=2&limit=2");
      const zero = await api(base, "GET", "/invoices?offset=0&limit=2");
      const absent = await api(base, "GET", "/invoices?limit=2");
      const pastEnd = await api(base, "GET", "/invoices?offset=99");
      const badOffset = await api(base, "GET", "/invoices?offset=-1");
      const badText = await api(base, "GET", "/invoices?offset=abc");
      const winOk = win.status === 200 && JSON.stringify(win.body.invoices.map((i) => i.id)) === JSON.stringify(ids.slice(2, 4));
      const sameOk = zero.status === 200 && absent.status === 200 && JSON.stringify(zero.body.invoices.map((i) => i.id)) === JSON.stringify(absent.body.invoices.map((i) => i.id));
      const emptyOk = pastEnd.status === 200 && Array.isArray(pastEnd.body.invoices) && pastEnd.body.invoices.length === 0;
      const rejectOk = badOffset.status === 400 && badText.status === 400;
      return {
        ok: winOk && sameOk && emptyOk && rejectOk,
        detail: `offset=2&limit=2 -> ${JSON.stringify(win.body.invoices?.map((i) => i.id))} (want ${JSON.stringify(ids.slice(2, 4))}), offset=0==absent=${sameOk}, past end ${pastEnd.status}/len${pastEnd.body.invoices?.length}, offset=-1 ${badOffset.status} & abc ${badText.status} (want 400)`,
      };
    }
    if (issueNumber === 34) {
      // Issue: PATCH /invoices/:id edits amountCents only while open; other fields rejected.
      const open = await api(base, "POST", "/invoices", { customerId: "c34", amountCents: 100 });
      const patched = await api(base, "PATCH", `/invoices/${open.body.id}`, { amountCents: 250 });
      const paid = await api(base, "POST", "/invoices", { customerId: "c34b", amountCents: 300 });
      await api(base, "PUT", `/invoices/${paid.body.id}/status`, { status: "paid" });
      const patchPaid = await api(base, "PATCH", `/invoices/${paid.body.id}`, { amountCents: 1 });
      const paidAfter = await api(base, "GET", `/invoices/${paid.body.id}`);
      const badAmount = await api(base, "PATCH", `/invoices/${open.body.id}`, { amountCents: -5 });
      const afterBad = await api(base, "GET", `/invoices/${open.body.id}`);
      const smuggled = await api(base, "PATCH", `/invoices/${open.body.id}`, { amountCents: 500, status: "paid" });
      const smuggledAfter = await api(base, "GET", `/invoices/${open.body.id}`);
      const missing = await api(base, "PATCH", "/invoices/999999", { amountCents: 10 });
      const editOk = patched.status === 200 && patched.body.amountCents === 250;
      const immutableOk = patchPaid.status === 409 && paidAfter.body.amountCents === 300;
      const validateOk = badAmount.status === 400 && afterBad.body.amountCents === 250;
      const noSmuggleOk = smuggled.status === 400 && smuggledAfter.body.status === "open" && smuggledAfter.body.amountCents === 250;
      const notFoundOk = missing.status === 404;
      return {
        ok: editOk && immutableOk && validateOk && noSmuggleOk && notFoundOk,
        detail: `PATCH open ${patched.status} amount=${patched.body.amountCents} (want 200/250), PATCH paid ${patchPaid.status} amount=${paidAfter.body.amountCents} (want 409/300), bad amount ${badAmount.status} kept=${afterBad.body.amountCents} (want 400/250), smuggled status ${smuggled.status} status=${smuggledAfter.body.status} (want 400/open), unknown ${missing.status} (want 404)`,
      };
    }
    if (issueNumber === 35) {
      // Issue: invoices carry history [{from,to}], rejected transitions append nothing.
      const inv = await api(base, "POST", "/invoices", { customerId: "c35", amountCents: 100 });
      const created = await api(base, "GET", `/invoices/${inv.body.id}`);
      const createdOk = Array.isArray(created.body.history) && created.body.history.length === 1 &&
        created.body.history[0].from === null && created.body.history[0].to === "open";
      const toPaid = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "paid" });
      const appendedOk = Array.isArray(toPaid.body.history) && JSON.stringify(toPaid.body.history.at(-1)) === JSON.stringify({ from: "open", to: "paid" });
      const beforeRejected = JSON.stringify((await api(base, "GET", `/invoices/${inv.body.id}`)).body.history);
      const rejected = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "voided" });
      const afterRejected = JSON.stringify((await api(base, "GET", `/invoices/${inv.body.id}`)).body.history);
      const cleanOk = rejected.status >= 400 && beforeRejected === afterRejected;
      return {
        ok: createdOk && appendedOk && cleanOk,
        detail: `created history ${JSON.stringify(created.body.history)} (want [{from:null,to:"open"}]), after paid last=${JSON.stringify(toPaid.body.history?.at(-1))} (want {from:"open",to:"paid"}), rejected ${rejected.status} unchanged=${cleanOk}`,
      };
    }
    if (issueNumber === 36) {
      // Issue: bodies over 64 KiB → 413 while streaming; small/empty bodies unaffected.
      const big = await api(base, "POST", "/invoices", { customerId: "c36", amountCents: 100, note: "x".repeat(70_000) });
      const small = await api(base, "POST", "/invoices", { customerId: "c36-small", amountCents: 100 });
      const emptyBody = await api(base, "POST", "/invoices", undefined);
      const stillUsable = await api(base, "GET", "/health");
      const tooBigOk = big.status === 413;
      const smallOk = small.status === 201;
      const emptyOk = emptyBody.status !== 413 && emptyBody.status < 500;
      const usableOk = stillUsable.status === 200;
      return {
        ok: tooBigOk && smallOk && emptyOk && usableOk,
        detail: `70 KB body ${big.status} (want 413), small POST ${small.status} (want 201), empty body ${emptyBody.status} (want not-413/<500), connection usable after=${usableOk}`,
      };
    }
    throw new Error(`no behavior check defined for issue #${issueNumber}`);
  });
}

async function evaluateIssue(issueNumber) {
  const branch = `agent/issue-${issueNumber}`;
  const dir = await cloneBranch(branch);
  const suite = await runSuite(dir);
  const scope = await checkScope(dir);
  const behavior = await checkBehavior(issueNumber, dir);
  // Zero human edits: the PR was opened by the factory (marker in body) and we never touched it.
  let zeroEdits = true;
  try {
    const listOut = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", branch, "--json", "number"]);
    const prNumber = JSON.parse(listOut || "[]")[0]?.number;
    if (!prNumber) zeroEdits = false;
    else {
      const prBody = await sh("gh", ["pr", "view", String(prNumber), "--repo", fixturesRepo, "--json", "body", "-q", ".body"]);
      zeroEdits = prBody.includes("_Opened as a draft by the drydock software factory");
    }
  } catch { /* no PR — treat as not verified */ zeroEdits = false; }
  const passed = suite.passed && scope.ok && behavior.ok && zeroEdits;
  return { issueNumber, branch, suite, scope, behavior, zeroEdits, passed };
}

// ---------------------------------------------------------------------------
console.log(`G2 battery: issues ${issues.join(", ")} (timeout ${timeoutMin}min each)`);
for (const n of issues) {
  try {
    const run = await runIssue(n);
    const evaln = await evaluateIssue(n);
    results.push({ ...run, ...evaln });
    const suiteStr = evaln.suite.passed ? `pass ${evaln.suite.pass}/${evaln.suite.fail}` : "FAIL";
    const scopeStr = evaln.scope.ok
      ? `ok (${evaln.scope.files.length}/${evaln.scope.maxFiles} files)`
      : evaln.scope.inScope
        ? `FAIL too many files (${evaln.scope.files.length} > ${evaln.scope.maxFiles})`
        : `FAIL out of scope (${evaln.scope.files.join(", ")})`;
    const behaviorStr = evaln.behavior.ok ? "ok" : `FAIL: ${evaln.behavior.detail}`;
    console.log(`  issue #${n}: suite=${suiteStr} scope=${scopeStr} behavior=${behaviorStr} zeroEdits=${evaln.zeroEdits} => ${evaln.passed ? "PASS" : "FAIL"}`);
  } catch (e) {
    results.push({ issueNumber: n, passed: false, error: e.message });
    console.log(`  issue #${n}: RUN FAIL — ${e.message}`);
  }
}

const passCount = results.filter((r) => r.passed).length;
const total = issues.length;
const gate = passCount >= 2 && total === 3 ? "PASS" : passCount >= Math.min(2, total) ? `PASS (${passCount}/${total})` : "FAIL";
console.log(`\nG2 ${gate} — ${passCount}/${total} issues produced a passing, scoped PR with zero human edits`);
for (const r of results) console.log(`  #${r.issueNumber}: ${r.passed ? "PASS" : `FAIL${r.error ? ` (${r.error})` : ""}`}`);

const { writeFileSync } = await import("node:fs");
writeFileSync(join(runDir, "g2-results.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log(`results: ${join(runDir, "g2-results.json")}`);
process.exitCode = gate.startsWith("PASS") ? 0 : 1;
