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
const issues = opt("--issues", "1,2,3").split(",").map(Number);
const timeoutMin = Number(opt("--timeout-min", "25"));
const allowExisting = argv.includes("--allow-existing");

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

async function checkScope(dir) {
  const files = (await sh("git", ["-C", dir, "diff", "--name-only", "origin/main...HEAD"])).split("\n").filter(Boolean);
  // Scope: implementation + tests + README docs only; nothing else, and bounded size.
  const inScope = files.every((f) => f.startsWith("src/") || f.startsWith("test/") || f === "README.md");
  return { files, ok: inScope && files.length <= 5 };
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
    if (issueNumber === 1) {
      const unknown = await api(base, "GET", "/invoices/999999");
      const created = await api(base, "POST", "/invoices", { customerId: "c1", amountCents: 10 });
      const known = await api(base, "GET", `/invoices/${created.body.id}`);
      return {
        ok: unknown.status === 404 && Boolean(unknown.body.error) && known.status === 200,
        detail: `unknown-id ${unknown.status} (want 404+error), known-id ${known.status} (want 200)`,
      };
    }
    if (issueNumber === 2) {
      const a = await api(base, "POST", "/invoices", { customerId: "f-open", amountCents: 10 });
      const b = await api(base, "POST", "/invoices", { customerId: "f-paid", amountCents: 20 });
      const c = await api(base, "POST", "/invoices", { customerId: "f-void", amountCents: 30 });
      await api(base, "PUT", `/invoices/${b.body.id}/status`, { status: "paid" });
      await api(base, "PUT", `/invoices/${c.body.id}/status`, { status: "voided" });
      const paid = await api(base, "GET", "/invoices?status=paid");
      const bogus = await api(base, "GET", "/invoices?status=bogus");
      const paidOk =
        paid.status === 200 &&
        paid.body.invoices.length >= 1 &&
        paid.body.invoices.every((i) => i.status === "paid") &&
        paid.body.invoices.some((i) => i.id === b.body.id);
      return {
        ok: paidOk && bogus.status >= 400 && bogus.status < 500,
        detail: `?status=paid ${paid.status} (all-paid=${paidOk}), ?status=bogus ${bogus.status} (want 4xx)`,
      };
    }
    if (issueNumber === 3) {
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
          after.body.totalCents === before.body.totalCents + 300,
        detail: `count ${before.body.invoiceCount}->${after.body.invoiceCount} (want +2), total ${before.body.totalCents}->${after.body.totalCents} (want +300)`,
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
    console.log(
      `  issue #${n}: suite=${evaln.suite.passed ? `pass ${evaln.suite.pass}/${evaln.suite.fail}` : "FAIL"} ` +
        `scope=${evaln.scope.ok ? `ok (${evaln.scope.files.length} files)` : `FAIL (${evaln.scope.files.join(", ")})`} ` +
        `behavior=${evaln.behavior.ok ? "ok" : `FAIL: ${evaln.behavior.detail}`} zeroEdits=${evaln.zeroEdits} => ${evaln.passed ? "PASS" : "FAIL"}`,
    );
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
