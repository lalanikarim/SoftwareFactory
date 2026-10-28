// Phase 2 / Gate G2 — worker quality on bounded real issues.
//
//   node gates/g2-worker-quality.mjs [--timeout-min 25] [--preflight-only]
//   node gates/g2-worker-quality.mjs --issues 34,35 [--allow-existing] [--max-files 6]
//
// TARGETS ARE SELECTED BY LABEL, NOT BY NUMBER. With no --issues, every open issue carrying
// `agent` (override: --target-label) is a target. Each target must also carry exactly one
// `probe:<key>` label naming its behavior oracle in gates/probes/. Both are resolved at PREFLIGHT,
// before any inference, so "no oracle for this target" costs seconds instead of a worker run.
//
// For each issue: if a draft PR already exists for agent/issue-<n> (and
// --allow-existing), evaluate it; otherwise run the full unattended chain
// (simulated webhook -> factory -> sandboxed worker -> draft PR).
//
// Objective checks per issue (no model judgment):
//   A. test suite passes on the resulting branch;
//   B. diff is scoped: every changed file under src/ or test/, <= --max-files (default 5);
//   C. the issue's oracle passes against a live server from the candidate branch;
//   D. zero human edits (PR body carries the factory marker).
//
// Preflight additionally requires each oracle to FAIL against fixture `main` (fail-to-pass): an
// oracle that already passes on main judges nothing — the work is merged, or the probe is wrong.
// Both are preflight failures. --skip-fail-to-pass overrides it; --preflight-only stops here.
//
// G2 passes when >= 2 targets (or all of them, when fewer than 2 exist) satisfy A-D.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NOTE: plain ESM — no TS syntax in .mjs gates (Node's strip-types does not
// transform .mjs); types are omitted throughout this file.
import { startIntakeServer } from "../factory/intake.ts";
import { loadFactoryEnv, spawnInstance, defaultConfigPath } from "./lib.ts";
import { loadProbes, probeKeyFromLabels, formatLabels } from "./behavior-probes.mjs";

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
// Explicit target list overrides label discovery; use it to evaluate one issue without pulling in
// every open `agent` issue. Numbers still need their `probe:<key>` label.
const issuesOpt = opt("--issues", "");
const targetLabel = opt("--target-label", "agent");
const preflightOnly = argv.includes("--preflight-only");
// Run every oracle against fixture main and report. Oracles for already-merged work stay in
// gates/probes/ without a label for exactly this: they are regression checks, and an oracle that
// silently stops passing on main means the feature it specified broke (or drifted).
const regression = argv.includes("--regression");
const skipFailToPass = argv.includes("--skip-fail-to-pass");
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

// Run an issue's behavior oracle against a booted checkout of the candidate branch.
// The oracle itself lives in gates/probes/<key>.mjs and is selected by the issue's
// `probe:<key>` label — see gates/behavior-probes.mjs for why this replaced per-issue-number
// if-blocks (a missing oracle used to surface only after a full worker run).
async function runProbe(probe, dir) {
  return withServer(dir, (base) => probe.check({ base, api }));
}

async function evaluateIssue(target, probe) {
  const issueNumber = target.number;
  const branch = `agent/issue-${issueNumber}`;
  const dir = await cloneBranch(branch);
  const suite = await runSuite(dir);
  const scope = await checkScope(dir);
  const behavior = await runProbe(probe, dir);
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
  return { issueNumber, title: target.title, labels: target.labels, probeKey: probe.key, branch, suite, scope, behavior, zeroEdits, passed };
}

// ---------------------------------------------------------------------------
// Target resolution + preflight. Everything here runs before a single inference call.
// ---------------------------------------------------------------------------
async function fetchIssue(number) {
  const out = await sh("gh", ["api", `repos/${fixturesRepo}/issues/${number}`, "--jq",
    "{number,title,state,labels:[.labels[].name]}"]);
  return JSON.parse(out);
}

async function listOpenIssueNumbers() {
  const out = await sh("gh", ["api", `repos/${fixturesRepo}/issues?state=open&per_page=100`, "--jq", "[.[].number]"]);
  return new Set(JSON.parse(out || "[]"));
}

async function discoverTargets() {
  const out = await sh("gh", ["api",
    `repos/${fixturesRepo}/issues?state=open&labels=${encodeURIComponent(targetLabel)}&per_page=100`,
    "--jq", "[.[] | {number,title,labels:[.labels[].name]}]"]);
  return JSON.parse(out || "[]");
}

/** -> { targets: [{ issue, probe }], problems: string[] } */
async function resolveTargets(probes) {
  const numbers = issuesOpt ? issuesOpt.split(",").map((s) => Number(s.trim())).filter(Number.isFinite) : (await discoverTargets()).map((i) => i.number);
  if (numbers.length === 0) {
    return { targets: [], problems: [`no open issues labeled "${targetLabel}" in ${fixturesRepo} — label a target or pass --issues`] };
  }
  const targets = [];
  const problems = [];
  for (const n of numbers) {
    let issue;
    try {
      issue = await fetchIssue(n);
    } catch (e) {
      problems.push(`#${n}: not readable (${e.message.split("\n")[0]})`);
      continue;
    }
    let key;
    try {
      key = probeKeyFromLabels(issue.labels);
    } catch (e) {
      problems.push(`#${n}: ${e.message}`);
      continue;
    }
    if (!key) {
      problems.push(`#${n} "${issue.title}" has no probe:<key> label — add the oracle label or drop it as a target`);
      continue;
    }
    const probe = probes.get(key);
    if (!probe) {
      problems.push(`#${n}: probe:${key} has no module in gates/probes/ (typo, or the oracle was deleted)`);
      continue;
    }
    targets.push({ issue, probe });
  }
  return { targets, problems };
}

/** Every oracle must fail against main, or it is not an oracle. */
async function checkFailToPass(targets) {
  const dir = await cloneBranch("main");
  const problems = [];
  for (const { issue, probe } of targets) {
    let res;
    try {
      res = await runProbe(probe, dir);
    } catch (e) {
      problems.push(`#${issue.number}: oracle ${probe.key} errored against main (${e.message.split("\n")[0]})`);
      continue;
    }
    if (res.ok) problems.push(`#${issue.number}: oracle ${probe.key} already PASSES on main — the work is merged or the probe is vacuous`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
const probes = await loadProbes();

if (regression) {
  // Oracles with no live target specify MERGED work: they must still hold against main.
  // Claimed oracles are expected to fail there (that is what makes their issue a target), so
  // they never count as regressions — but one that passes on main means the work landed and the
  // target is stale, which gets reported.
  const { targets: live } = await resolveTargets(probes);
  const claimed = new Map(live.map((t) => [t.probe.key, t.issue.number]));
  const openIssues = await listOpenIssueNumbers();
  const dir = await cloneBranch("main");
  let regressed = 0;
  console.log(`G2 regression: ${probes.size} oracles against ${fixturesRepo}@main (${live.length} claimed by live targets)`);
  for (const probe of probes.values()) {
    let res;
    try {
      res = await runProbe(probe, dir);
    } catch (e) {
      res = { ok: false, detail: e.message.split("\n")[0] };
    }
    const claim = claimed.get(probe.key);
    if (claim !== undefined) {
      console.log(`  ${res.ok ? "STALE" : "open "} #${claim} ${probe.key}: ${res.ok ? "oracle already passes on main — target is implemented, retarget or close it" : "expected to fail until the target lands"}`);
    } else if (res.ok) {
      console.log(`  ok      ${probe.key}: ${res.detail}`);
    } else if (probe.sourceIssue !== undefined && openIssues.has(probe.sourceIssue)) {
      // Not a regression: this behavior was never shipped. Issue #18 is exactly this case — an
      // open draft PR, so main still fails the oracle. It IS a missing target, so say so.
      console.log(`  UNTARGET #${probe.sourceIssue} ${probe.key}: unsatisfied on main and its issue is still open — label it (agent + probe:${probe.key}) or close the issue`);
    } else {
      regressed += 1;
      console.log(`  REGRESS ${probe.key}${probe.sourceIssue !== undefined ? ` (specified by #${probe.sourceIssue}, now closed)` : ""}: ${res.detail}`);
    }
  }
  console.log(`\nG2 regression ${regressed === 0 ? "PASS" : `FAIL — ${regressed} oracle(s) no longer hold against main`}`);
  process.exit(regressed === 0 ? 0 : 1);
}

console.log(`G2 preflight: ${probes.size} oracles loaded; targets from ${issuesOpt ? `--issues ${issuesOpt}` : `label "${targetLabel}"`}`);
const { targets, problems: resolveProblems } = await resolveTargets(probes);
let problems = resolveProblems;
if (targets.length > 0 && !skipFailToPass) {
  const ftp = await checkFailToPass(targets);
  problems = problems.concat(ftp);
}
const claimed = new Set(targets.map((t) => t.probe.key));
for (const { issue, probe } of targets) {
  console.log(`  #${issue.number} [${formatLabels(issue.labels)}] -> ${probe.key}: ${probe.title}`);
}
const unclaimed = [...probes.keys()].filter((k) => !claimed.has(k));
if (unclaimed.length) {
  console.log(`  (${unclaimed.length} further oracles cover merged work — run --regression to re-check them against main)`);
}
for (const p of problems) console.log(`  PROBLEM ${p}`);
if (preflightOnly) {
  console.log(problems.length ? `\nG2 preflight: ${problems.length} problem(s)` : `\nG2 preflight OK — ${targets.length} target(s), all oracles fail against main`);
  process.exitCode = problems.length ? 1 : 0;
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) {
  console.error(`\nG2 PREFLIGHT FAILED (${problems.length} problem(s)) — nothing was run, so no worker time was spent on unresolvable targets`);
  process.exit(2);
}

console.log(`G2 battery: issues ${targets.map((t) => t.issue.number).join(", ")} (timeout ${timeoutMin}min each)`);
for (const { issue, probe } of targets) {
  const n = issue.number;
  try {
    const run = await runIssue(n);
    const evaln = await evaluateIssue(issue, probe);
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
const total = targets.length;
const gate = passCount >= 2 && total === 3 ? "PASS" : passCount >= Math.min(2, total) ? `PASS (${passCount}/${total})` : "FAIL";
console.log(`\nG2 ${gate} — ${passCount}/${total} issues produced a passing, scoped PR with zero human edits`);
for (const r of results) console.log(`  #${r.issueNumber}: ${r.passed ? "PASS" : `FAIL${r.error ? ` (${r.error})` : ""}`}`);

const { writeFileSync } = await import("node:fs");
writeFileSync(join(runDir, "g2-results.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log(`results: ${join(runDir, "g2-results.json")}`);
process.exitCode = gate.startsWith("PASS") ? 0 : 1;
