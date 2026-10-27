// Phase 4 battery — Gate G4: evidence complete on the PR; exactly-once merge
// across a mid-approval SIGKILL.
//
// The factory runs as a CHILD PROCESS so the battery can SIGKILL it and restart
// it over the same database. The battery is the human driver: it reads pending
// approval keys from GET /approvals and records decisions via POST /approvals
// (standing in for Telegram inline buttons — same durable-decision mechanism).
//
//   T1 happy    — merge directive -> review gate -> evidence on PR -> merge_pr
//                 blocks -> approve -> retry -> merged; verify exactly one merge
//                 commit landed and the approval record was consumed (single-use).
//   T2 crash    — same flow, but SIGKILL while the merge approval is pending ->
//                 restart over the SAME db -> pending key survives -> approve ->
//                 retry -> merged exactly once.
//
// Targets existing draft PRs from G2/G3 (no worker re-run): by default issue #4
// (PR #9) for T1 and issue #2 (PR #7) for T2; override with G4_T1_ISSUE /
// G4_T2_ISSUE. NOTE: passing this gate MERGES the target PRs on the fixture
// repo — retarget once a default has already been merged by an earlier run.
//
// G4_MODE=work re-runs the full chain (worker -> review -> draft PR -> merge)
// instead of targeting an existing branch directly; use it when the target
// branch is stale/conflicting with main. Default: merge.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFactoryDotEnv } from "./lib/factory.mjs";
import { loadDotEnv } from "../vendor/engram/poc/lib/env.mjs";

const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
loadFactoryDotEnv(__dirname);
loadDotEnv();

const REPO = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";
const GH_ENV = { ...process.env, GH_TOKEN: process.env.FACTORY_GITHUB_TOKEN ?? "" };
const T1_ISSUE = Number(process.env.G4_T1_ISSUE ?? 4);
const T2_ISSUE = Number(process.env.G4_T2_ISSUE ?? 2);
const MODE = process.env.G4_MODE === "work" ? "work" : "merge";
const WAIT_APPROVAL_MS = 25 * 60 * 1000;
const WAIT_MERGED_MS = 15 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

async function http(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function spawnFactory({ port, dbPath, logFile, fresh }) {
  if (fresh) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(dbPath + suffix, { force: true });
  }
  const child = spawn(process.execPath, [join(__dirname, "lib/factory.mjs"), String(port), dbPath], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Attached at spawn so later awaits can never miss the exit event. Resolves
  // with {code, signal} — the event args are authoritative (ChildProcess.signal
  // is not set on this Node build for self-sent signals).
  child.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const chunks = [];
  child.stdout.on("data", (d) => { chunks.push(d); appendFileSync(logFile, d); });
  child.stderr.on("data", (d) => { chunks.push(d); appendFileSync(logFile, d); });
  child.outputLog = () => Buffer.concat(chunks).toString("utf8");
  return child;
}

async function waitHealthy(child, port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`factory exited early (code=${child.exitCode} signal=${child.signal})\n${tail(child.outputLog())}`);
    try {
      const { status } = await http(port, "GET", "/health");
      if (status === 200) return;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`factory did not become healthy within ${timeoutMs / 1000}s\n${tail(child.outputLog())}`);
}

function tail(text, n = 2000) {
  return text.length > n ? `…${text.slice(-n)}` : text;
}

async function submit(port, content, requestId) {
  const { status, json } = await http(port, "POST", "/tasks", { content, requestId });
  if (status !== 202) throw new Error(`submit failed: ${status} ${JSON.stringify(json)}`);
  return json;
}

/** Poll until a merge approval key is pending (decision not yet approved). */
async function waitForPendingApproval(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, json } = await http(port, "GET", "/approvals");
    if (status === 200) {
      const pending = (json.approvals ?? []).find((a) => a.decision !== "approved");
      if (pending) return pending;
    }
    await sleep(5000);
  }
  throw new Error(`no pending merge approval within ${timeoutMs / 1000}s`);
}

async function approve(port, key, decidedBy = "g4-battery") {
  const { status, json } = await http(port, "POST", "/approvals", { key, decision: "approved", decidedBy });
  if (status !== 200) throw new Error(`approve failed: ${status} ${JSON.stringify(json)}`);
  return json;
}

async function prInfo(n) {
  const out = await sh("gh", ["pr", "view", String(n), "--repo", REPO, "--json", "number,state,isDraft,url,mergeCommit,headRefOid,body"], { env: GH_ENV });
  return JSON.parse(out);
}

/** The PR currently tracking a head branch (merged preferred, else open).
 *  Tracking by branch — not number — because rework replaces the branch tip
 *  and may create a new PR for the same head. */
async function prForHead(branch) {
  const out = await sh("gh", ["pr", "list", "--repo", REPO, "--state", "all", "--head", branch, "--json", "number,state,isDraft,url,headRefOid,mergeCommit,body"], { env: GH_ENV });
  const list = JSON.parse(out || "[]");
  return list.find((p) => p.state === "MERGED") ?? list.find((p) => p.state === "OPEN") ?? null;
}

async function waitMergedForHead(branch, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pr = await prForHead(branch);
    if (pr && pr.state === "MERGED") return pr;
    await sleep(10_000);
  }
  throw new Error(`no merged PR for ${branch} within ${timeoutMs / 1000}s`);
}

/** Exactly-once merge verification on a fresh clone: between preMainSha and the
 *  new origin/main there must be exactly one merge commit and exactly one
 *  non-merge commit, which must be the PR's head. */
async function verifySingleMerge({ preMainSha, expectedHeadSha }) {
  const tmp = mkdtempSync(join(tmpdir(), "g4-verify-"));
  try {
    const authUrl = process.env.FACTORY_GITHUB_TOKEN
      ? `https://x-access-token:${process.env.FACTORY_GITHUB_TOKEN}@github.com/${REPO}.git`
      : `https://github.com/${REPO}.git`;
    await sh("git", ["clone", "--quiet", authUrl, tmp]);
    const merges = (await sh("git", ["-C", tmp, "rev-list", "--merges", `${preMainSha}..origin/main`])).split("\n").filter(Boolean);
    const nonMerges = (await sh("git", ["-C", tmp, "rev-list", "--no-merges", `${preMainSha}..origin/main`])).split("\n").filter(Boolean);
    return {
      ok: merges.length === 1 && nonMerges.length === 1 && nonMerges[0] === expectedHeadSha,
      mergeCommits: merges.length,
      nonMergeShas: nonMerges,
      expectedHeadSha,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const EVIDENCE_SECTIONS = [
  "## Diff summary",
  "## Independent review (read-only subagent)",
  "Reviewer concerns:",
  "## Test suite (host-verified at PR creation)",
  "## Worker report (transcript excerpt)",
];

async function checkEvidence(pr) {
  const missing = EVIDENCE_SECTIONS.filter((s) => !(pr.body ?? "").includes(s));
  const body = pr.body ?? "";
  return {
    ok: missing.length === 0 && /## Independent review[^\n]*\nPASS/.test(body) && /PASS — \d+ tests, \d+ passed, 0 failed/.test(body),
    missing,
    reviewPass: /## Independent review[^\n]*\nPASS/.test(body),
    testCounts: /PASS — \d+ tests, \d+ passed, 0 failed/.test(body),
  };
}

async function preflight() {
  const problems = [];
  // gh auth; in merge mode both targets must have an open draft PR.
  try {
    await sh("gh", ["pr", "list", "--repo", REPO, "--state", "open", "--json", "number"], { env: GH_ENV });
  } catch (e) {
    problems.push(`gh access failed: ${e.message}`);
  }
  if (MODE === "merge") {
    for (const issue of new Set([T1_ISSUE, T2_ISSUE])) {
      try {
        const out = await sh("gh", ["pr", "list", "--repo", REPO, "--state", "open", "--head", `agent/issue-${issue}`, "--json", "number"], { env: GH_ENV });
        if (JSON.parse(out || "[]").length === 0) problems.push(`no open draft PR for agent/issue-${issue} — run G2/G3 first`);
      } catch (e) {
        problems.push(`gh access failed: ${e.message}`);
      }
    }
  }
  // Podman + sandbox image (the review gate runs tests in the sandbox).
  try {
    const images = await sh("podman", ["images", "--format", "{{.Repository}}"]);
    if (!images.split("\n").some((l) => l.includes("factory-sandbox"))) problems.push("factory-sandbox image missing — podman build -t factory-sandbox:latest poc/sandbox-image/");
  } catch (e) {
    problems.push(`podman unavailable: ${e.message}`);
  }
  // Inference endpoint reachable.
  try {
    const res = await fetch(`${process.env.OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` } });
    if (!res.ok) problems.push(`inference endpoint unhealthy: HTTP ${res.status}`);
  } catch (e) {
    problems.push(`inference endpoint unreachable: ${e.message}`);
  }
  return problems;
}

async function killFactory(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await sleep(3000);
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
}

async function runMergeFlow({ label, issue, port, dbPath, logFile, crashAfterPending, mode = "merge" }) {
  const started = Date.now();
  const result = { label, issue, wallSecs: 0, events: [] };
  const ev = (name, extra = {}) => { result.events.push({ at: now(), name, ...extra }); console.log(`[${label}] ${name} ${Object.keys(extra).length ? JSON.stringify(extra) : ""}`); };

  const branch = `agent/issue-${issue}`;
  let child = spawnFactory({ port, dbPath, logFile, fresh: true });
  try {
    await waitHealthy(child, port);
    ev("factory-up");

    // Baseline: main sha before the merge; the PR tracking this head branch at
    // start (informational — rework may replace it with a new PR number).
    const prePr = await prForHead(branch);
    result.prNumberAtStart = prePr?.number ?? null;
    const preMainSha = (await sh("gh", ["api", `repos/${REPO}/commits/main`, "--jq", ".sha"], { env: GH_ENV }));
    ev("baseline", { prNumberAtStart: result.prNumberAtStart, preMainSha });

    const directive = mode === "work"
      ? `Work on GitHub issue number: ${issue}.`
      : `Merge pull request for issue number: ${issue}.`;
    await submit(port, directive, `g4-${label}-${mode}`);
    ev(`submitted-${mode}-directive`);

    const pending = await waitForPendingApproval(port, WAIT_APPROVAL_MS);
    result.approvalKey = pending.key;
    ev("approval-pending", { key: pending.key });

    // Evidence must already be on the PR (open_draft_pr refreshed it before the
    // merge gate could block). Resolved by head branch at this point: in work
    // mode the branch was re-pushed on top of current main, so this PR's head
    // is the commit that will land.
    const prNow = await prForHead(branch);
    if (!prNow || prNow.state !== "OPEN") throw new Error(`no open PR for ${branch} after open_draft_pr`);
    result.prNumber = prNow.number;
    result.evidence = await checkEvidence(prNow);
    result.expectedHeadSha = prNow.headRefOid;
    ev("evidence-checked", { prNumber: prNow.number, ok: result.evidence.ok, missing: result.evidence.missing });

    if (crashAfterPending) {
      // G4 crash test: SIGKILL while the merge approval is pending.
      child.kill("SIGKILL");
      const exitInfo = await child.exited;
      if (exitInfo.signal !== "SIGKILL") throw new Error(`factory did not die by SIGKILL (code=${exitInfo.code} signal=${exitInfo.signal})`);
      ev("sigkill-while-pending");

      child = spawnFactory({ port, dbPath, logFile, fresh: false }); // SAME database
      await waitHealthy(child, port);
      ev("factory-restarted");

      const survived = await waitForPendingApproval(port, 5 * 60 * 1000);
      if (survived.key !== pending.key) throw new Error(`pending key changed across restart: ${pending.key} -> ${survived.key}`);
      result.crashSurvived = true;
      ev("approval-state-survived-restart", { key: survived.key });
    }

    await approve(port, pending.key, "g4-battery");
    ev("approved");

    await submit(
      port,
      `The human has APPROVED merge approval key ${pending.key}. Call merge_pr again with exactly { issueNumber: ${issue} } and report the result.`,
      `g4-${label}-retry`,
    );
    ev("submitted-retry");

    const mergedPr = await waitMergedForHead(branch, WAIT_MERGED_MS);
    result.mergeCommit = mergedPr.mergeCommit?.oid ?? null;
    ev("merged", { mergeCommit: result.mergeCommit });

    result.singleMerge = await verifySingleMerge({ preMainSha, expectedHeadSha: result.expectedHeadSha });
    ev("single-merge-verified", { ok: result.singleMerge.ok, ...result.singleMerge });

    if (!crashAfterPending) {
      // Single-use check: the consumed approval must be recorded durably.
      const { json } = await http(port, "GET", "/approvals");
      const rec = (json.approvals ?? []).find((a) => a.key === pending.key);
      result.approvalConsumed = !!rec && rec.consumed === true && rec.decision === "approved" && !!rec.decidedBy;
      ev("approval-consumed", { ok: result.approvalConsumed, record: rec ?? null });
    }

    result.pass =
      result.evidence.ok &&
      result.singleMerge.ok &&
      (crashAfterPending ? result.crashSurvived === true : result.approvalConsumed === true);
  } finally {
    await killFactory(child);
    result.wallSecs = Math.round((Date.now() - started) / 1000);
  }
  return result;
}

const only = process.argv.slice(2).filter((a) => a.startsWith("--"));
const skipCrash = only.includes("--skip-crash");

const problems = await preflight();
if (problems.length) {
  console.error("G4 PREFLIGHT FAILED:\n- " + problems.join("\n- "));
  process.exit(2);
}

const results = { date: now(), repo: REPO, t1: null, t2: null };

console.log(`[t1] happy path: issue #${T1_ISSUE} (fresh db, approve -> merge -> verify)`);
results.t1 = await runMergeFlow({ label: "t1", issue: T1_ISSUE, port: 9641, dbPath: join(__dirname, "data/g4-t1.sqlite"), logFile: join(__dirname, "data/g4-t1-factory.log"), crashAfterPending: false, mode: MODE });
console.log(`[t1] ${results.t1.pass ? "PASS" : "FAIL"} in ${results.t1.wallSecs}s`);

if (!skipCrash) {
  console.log(`[t2] crash: issue #${T2_ISSUE} (SIGKILL while approval pending -> restart -> approve -> merge)`);
  results.t2 = await runMergeFlow({ label: "t2", issue: T2_ISSUE, port: 9642, dbPath: join(__dirname, "data/g4-t2.sqlite"), logFile: join(__dirname, "data/g4-t2-factory.log"), crashAfterPending: true, mode: MODE });
  console.log(`[t2] ${results.t2.pass ? "PASS" : "FAIL"} in ${results.t2.wallSecs}s`);
}

writeFileSync(join(__dirname, "data/g4-results.json"), JSON.stringify(results, null, 2));
const pass = results.t1?.pass === true && (skipCrash || results.t2?.pass === true);
console.log(`\nGATE G4: ${pass ? "PASS" : "FAIL"} — evidence complete on PR; exactly-once merge across crash`);
process.exitCode = pass ? 0 : 1;
