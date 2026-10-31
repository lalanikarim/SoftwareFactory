// Phase 2 / Gate G3 — independent reviewer (factory/ composition).
//
//   node --experimental-strip-types gates/g3-reviewer.mjs [--skip-chain] [--request-id <id>]
//
// Tests:
//   T1 (negative): reviewer on the seeded bad branch agent/issue-4-seeded-bad
//      (the "obvious fix" for trap issue #4: a timeout that stops the hang by
//      resolving with a fake error payload — no status surfaced, retries never
//      fire). Must return verdict fail with a reason pointing at the root cause.
//   T2 (positive control): reviewer on a SEEDED good fix for the same trap issue #4
//      (agent/issue-4-seeded-good: bounded timeout, HTTP status errors still fatal, own suite green).
//      It used to name agent/issue-1 literally; once that merged, its diff against main was empty and the
//      control passed on nothing. Must pass.
//   T3 (closed loop): full chain on trap issue #4 via the PRODUCTION entrypoint
//      (factory/main.ts child process) + intake. Worker commits; open_draft_pr
//      runs the review; fail => no draft PR + finding reported; pass => draft
//      PR exists. Informational for the gate; records the loop.
//
// Gate G3: T1 caught (fail + substantive reason) AND T2 passed.
//
// T1/T2 compose a minimal core instance (createCoreInstance seam) carrying the
// PRODUCTION reviewer extension (factory/reviewer.ts) plus a small local
// "review" root tool that mirrors open_draft_pr's createTask+waitForTask call —
// no factory logic is re-implemented here.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createCoreInstance } from "../vendor/engram/app/src/core.ts";
import { loadConfig } from "../vendor/engram/app/src/config.ts";
import { factoryReviewerTask, makeReviewerRoleTools } from "../factory/reviewer.ts";
import { loadFactoryEnv, spawnInstance, defaultConfigPath, rootConversationId, waitForToolResult } from "./lib.ts";

const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

const ctx = BACKGROUND_CONTEXT;
loadFactoryEnv();
const fixturesRepo = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";
const image = process.env.FACTORY_SANDBOX_IMAGE ?? "factory-sandbox:latest";
const skipChain = process.argv.includes("--skip-chain");
// T3 target must be an UNIMPLEMENTED issue on the fixture repo. It used to be hardcoded to #4,
// which was merged long ago: the worker found nothing to do, produced no open_draft_pr outcome,
// and the leg printed `verdict=null draftPR=false gateHeld=false` for ~100s while the gate still
// reported PASS — because T3 was never part of the verdict. Now: 0 means "skip, say so", and when
// it runs its outcome is asserted (see the gate computation at the bottom).
const t3Issue = Number(process.argv.includes("--t3-issue") ? process.argv[process.argv.indexOf("--t3-issue") + 1] : (process.env.G3_T3_ISSUE ?? 0));
// Deterministic intake requestIds (issue-<n>) make redeliveries exactly-once no-ops.
// Pass --request-id <id> for a fresh dev re-run of the chain.
const requestIdOverride = (() => {
  const i = process.argv.indexOf("--request-id");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const runDir = await mkdtemp(join(tmpdir(), "gates-g3-"));
const results = { t1: null, t2: null, t3: null };

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
async function preflight() {
  const models = await fetch(`${process.env.OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
  if (!models.ok) throw new Error(`inference endpoint /models returned ${models.status}`);
  await sh("podman", ["image", "exists", image]);
  await sh("gh", ["api", `repos/${fixturesRepo}`, "--jq", ".full_name"]);
}

/** Resolve the factory's model ref: "auto" probes the endpoint for the loaded model. */
async function resolveModelRef() {
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GET /models failed: ${res.status}`);
  const j = await res.json();
  const list = j.data ?? [];
  if (!list.length) throw new Error("endpoint reported no models");
  const m = list.find((x) => x.loaded) ?? list[0];
  console.log(`resolved auto model: ${m.id}`);
  return { provider: "aurora", modelId: m.id };
}

// ---------------------------------------------------------------------------
// Seeded bad branch for the negative test (idempotent fixture artifact).
// ---------------------------------------------------------------------------
const SEEDED_RETRY = `// Minimal HTTP client + retry wrapper used by the reporting job to pull data
// from upstream services.

export class HttpError extends Error {
  constructor(status, url) {
    super(\`HTTP \${status} from \${url}\`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fix: cap request() so a hanging upstream can never stall callers.
const DEFAULT_TIMEOUT_MS = 10_000;

export async function request(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    // Any HTTP status is treated as success; the caller gets the parsed body.
    return await res.json();
  } catch (err) {
    // A hanging upstream must not hang the caller: surface a bounded error payload.
    if (err.name === "AbortError") {
      return { error: \`upstream timeout after \${DEFAULT_TIMEOUT_MS}ms\` };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Call fn up to (retries + 1) times. Retries only happen when fn throws.
export async function withRetry(fn, { retries = 3, delayMs = 50 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastError;
}
`;

const SEEDED_TEST_APPEND = `
test("request to a hanging 503 upstream is bounded and returns an error marker", async () => {
  const mock = await startMock((req, res) => {
    res.writeHead(503); // never ends the body — simulates a stuck upstream
  });
  try {
    const t0 = Date.now();
    const result = await request(\`http://127.0.0.1:\${mock.port}/data\`);
    assert.ok(Date.now() - t0 < 30_000, "must be bounded");
    assert.equal(typeof result.error, "string", "error marker surfaced");
  } finally {
    mock.server.close();
  }
});
`;

const SEEDED_BRANCH = "agent/issue-4-seeded-bad";

async function ensureSeededBadBranch() {
  let exists = false;
  try {
    const out = (await sh("git", ["ls-remote", `https://github.com/${fixturesRepo}.git`, `refs/heads/${SEEDED_BRANCH}`])).trim();
    exists = out.length > 0;
  } catch { /* treat as missing */ }
  if (exists) {
    console.log(`seeded bad branch ${SEEDED_BRANCH} already present`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "g3-seed-"));
  await sh("git", ["clone", "--quiet", "--branch", "main", `https://github.com/${fixturesRepo}.git`, join(dir, "repo")]);
  const repo = join(dir, "repo");
  writeFileSync(join(repo, "src/retry.mjs"), SEEDED_RETRY);
  appendFileSync(join(repo, "test/retry.test.mjs"), SEEDED_TEST_APPEND);
  // Sanity: the seeded branch's own suite must pass (that's what makes it a trap).
  await sh("node", ["--test"], { cwd: repo });
  await sh("git", ["-C", repo, "add", "src/retry.mjs", "test/retry.test.mjs"]);
  await sh("git", ["-C", repo, "-c", "user.name=software-factory-poc", "-c", "user.email=factory@localhost", "commit", "-q", "-m", "Seed: bounded-timeout fix for hanging upstreams (review fixture)"]);
  await sh("git", ["-C", repo, "push", "--quiet", "origin", "HEAD:refs/heads/" + SEEDED_BRANCH]);
  console.log(`seeded bad branch ${SEEDED_BRANCH} pushed (own suite passes — it is a trap)`);
}

// T2's positive control used to name the branch `agent/issue-1`. It stopped being a control the moment it
// merged: the reviewer's git_diff tool compares `origin/main...HEAD`, so a merged branch is an EMPTY diff,
// and "the reviewer passes on known-good work" quietly became "the reviewer passes on nothing at all".
//
// Ref-archaeology does not fix this. Verified against the live fixture: `refs/pull/10/head` still resolves
// to the old head commit, but diffing it against main is empty — a merged change is an ancestor of main by
// construction. A positive control therefore has to be work that is NOT in main.
//
// So seed a good twin of T1's trap: same issue #4, correct implementation (a bounded timeout on the
// request, with non-2xx still rejecting as HttpError carrying its status), plus tests for both paths. The
// gate runs the seeded branch's own suite before pushing — that is what earns "known good" — and refuses to
// run inference on an empty diff, so this class of rot can never report green again.
const SEEDED_GOOD_RETRY = `// Minimal HTTP client + retry wrapper used by the reporting job to pull data
// from upstream services.

export class HttpError extends Error {
  constructor(status, url) {
    super(\`HTTP \${status} from \${url}\`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

/** Raised when the upstream stops responding within \`timeoutMs\`. */
export class TimeoutError extends Error {
  constructor(timeoutMs, url) {
    super(\`upstream did not respond within \${timeoutMs}ms: \${url}\`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
    this.url = url;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Fetch a URL and return the parsed JSON body.
//
// Two upstream failure modes must never look like success: a non-2xx status (HttpError, carrying the
// status) and an upstream that accepts the connection but never answers (TimeoutError, after timeoutMs).
// Both reject, so withRetry actually retries them and callers see an error instead of a body.
export async function request(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
    if (!res.ok) {
      // Non-2xx responses are errors: surface the status without waiting on
      // (or parsing) the error body, so a stalled upstream can't hang us.
      try {
        await res.body?.cancel();
      } catch {}
      throw new HttpError(res.status, url);
    }
    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError") throw new TimeoutError(timeoutMs, url);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Call fn up to (retries + 1) times. Retries only happen when fn throws.
export async function withRetry(fn, { retries = 3, delayMs = 50 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastError;
}
`;

const SEEDED_GOOD_TEST_APPEND = `
// Positive-control tests for the timeout path: an upstream that never answers must reject, bounded, and
// a timeout must be retried like any other failure.
test("request rejects with TimeoutError when the upstream never answers", async () => {
  const mock = await startMock(() => {
    // Accept the connection and answer nothing at all: an unbounded client hangs here forever.
  });
  try {
    const started = Date.now();
    await assert.rejects(
      request(\`http://127.0.0.1:\${mock.port}/data\`, { timeoutMs: 250 }),
      (err) => err.name === "TimeoutError" && err.timeoutMs === 250
    );
    assert.ok(Date.now() - started < 5000, "must fail within a bounded time");
  } finally {
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});

test("withRetry retries an unresponsive upstream and rejects with TimeoutError", async () => {
  let connections = 0;
  const mock = await startMock(() => {
    connections += 1;
  });
  try {
    const started = Date.now();
    await assert.rejects(
      withRetry(() => request(\`http://127.0.0.1:\${mock.port}/data\`, { timeoutMs: 200 }), {
        retries: 2,
        delayMs: 1,
      }),
      (err) => err.name === "TimeoutError"
    );
    assert.equal(connections, 3, "a timeout must be retried like any other failure");
    assert.ok(Date.now() - started < 5000, "must fail within a bounded time");
  } finally {
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});
`;

const SEEDED_GOOD_BRANCH = "agent/issue-4-seeded-good";

async function ensureSeededGoodBranch() {
  const remote = `https://github.com/${fixturesRepo}.git`;
  const existing = (await sh("git", ["ls-remote", remote, `refs/heads/${SEEDED_GOOD_BRANCH}`])).trim();
  if (existing) {
    console.log(`positive control branch ${SEEDED_GOOD_BRANCH} already present`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "g3-good-"));
  const repo = join(dir, "repo");
  await sh("git", ["clone", "--quiet", "--branch", "main", remote, repo]);
  writeFileSync(join(repo, "src/retry.mjs"), SEEDED_GOOD_RETRY);
  appendFileSync(join(repo, "test/retry.test.mjs"), SEEDED_GOOD_TEST_APPEND);
  // The control is only positive if it is actually correct: run its suite before pushing.
  await sh("node", ["--test"], { cwd: repo });
  const diff = (await sh("git", ["-C", repo, "diff", "--name-only", "HEAD"])).trim();
  if (!diff) throw new Error(`positive control ${SEEDED_GOOD_BRANCH} has an empty diff — refusing to seed a control that reviews nothing`);
  await sh("git", ["-C", repo, "add", "src/retry.mjs", "test/retry.test.mjs"]);
  await sh("git", ["-C", repo, "-c", "user.name=software-factory-poc", "-c", "user.email=factory@localhost", "commit", "-q", "-m", "Seed: bounded-timeout fix that keeps HTTP status errors fatal (positive review fixture)"]);
  await sh("git", ["-C", repo, "push", "--quiet", "origin", `HEAD:refs/heads/${SEEDED_GOOD_BRANCH}`]);
  console.log(`positive control branch ${SEEDED_GOOD_BRANCH} pushed (own suite passes — that is what makes it positive)`);
}

// ---------------------------------------------------------------------------
// Isolated reviewer run on its own core instance (seam composition).
// ---------------------------------------------------------------------------
async function runReviewer({ label, branch, issueNumber }) {
  const modelRef = await resolveModelRef();
  const root = join(runDir, label);
  const dataDir = join(root, "engram-data");
  const configDir = join(root, "config");
  const workRoot = join(root, "work");
  for (const d of [dataDir, configDir, workRoot]) mkdirSync(d, { recursive: true });

  const reviewerTaskDef = factoryReviewerTask({ workDir: workRoot, fixturesRepo, image });
  const reviewerRoleTools = makeReviewerRoleTools({ workDir: workRoot });
  // Test glue mirroring open_draft_pr's review invocation (createTask + waitForTask).
  const reviewTool = defineTool({
    name: "review",
    description: "Run the independent reviewer on a branch. Returns the verdict JSON.",
    parameters: Type.Object({ branch: Type.String(), issueNumber: Type.Integer() }),
    replay: "unsafe", // spawns a child task; the harness tracks it durably
    execute: async (args, api, c) => {
      const id = await api.createTask(
        reviewerTaskDef,
        { branch: args.branch, issueNumber: args.issueNumber, ...modelRef },
        { ownership: { kind: "task", taskId: api.taskId } },
        c,
      );
      const settled = await api.waitForTask(id, c);
      return {
        output: [{ type: "text", text: JSON.stringify(settled.state.outcome?.result ?? { error: String(settled.state.status) }) }],
      };
    },
  });

  process.env.API_TOKEN = randomBytes(16).toString("hex");
  const config = loadConfig({
    dataDir,
    configDir,
    workRoot,
    sandbox: { image, network: "none", allowImages: [image], allowMountRoot: workRoot },
  });
  // reviewTool must be registry-installed (agent `tools` filters resolve by
  // name against the registry); unregistered definitions are silently dropped.
  const ext = defineExtension({ name: "factory-reviewer", tools: [...reviewerRoleTools, reviewTool], tasks: [reviewerTaskDef] });
  const inst = await createCoreInstance({
    config,
    extraExtensions: [ext],
    port: 0,
    rootAgent: {
      model: modelRef,
      thinkingLevel: "medium",
      tools: [reviewTool],
      instructions:
        "You run one review per message. Call review with the branch and issue number given in the message, wait for its result, then answer with exactly the verdict JSON the tool returned (no other text).",
    },
  });

  try {
    const rootConv = await inst.harness.conversation(inst.rootConversationId, ctx);
    const t0 = Date.now();
    const sub = await rootConv.submit(
      { type: "input", content: `Review branch ${branch} for issue #${issueNumber}. Call review({branch: "${branch}", issueNumber: ${issueNumber}}).`, requestId: `g3-${label}` },
      ctx,
    );
    const settled = await sub.wait(ctx);
    const wallSecs = Math.round((Date.now() - t0) / 1000);

    // Ground truth: the reviewer task's durable outcome (not the root's prose).
    const page = await rootConv.commit((tx) => tx.scanTasks({ kind: "factory.reviewer" }, 10), ctx);
    const taskRecords = page.items;
    const verdict = taskRecords.length > 0 ? taskRecords[taskRecords.length - 1].state.outcome?.result : null;
    return { label, branch, issueNumber, wallSecs, settledStatus: settled.status, verdict };
  } finally {
    await inst.close();
  }
}

// ---------------------------------------------------------------------------
// Objective reason-quality check for the negative test.
// The root cause of #4: non-2xx responses are treated as success, so no error
// carries the upstream HTTP status and retries never fire. A substantive
// reason must name the status-surfacing defect AND the retry/masking effect.
// ---------------------------------------------------------------------------
function reasonPointsAtRootCause(verdict) {
  if (!verdict || verdict.verdict !== "fail") return false;
  const text = [...(verdict.concerns ?? []), ...(verdict.evidence ?? [])].join(" ").toLowerCase();
  const statusSignal = /http status|status code|5\d\d|non-2xx|not 2xx|httperror|surfaces? the (upstream )?status/.test(text);
  const rootCauseSignal = /retr(y|ies|ied)|never fires|mask|as success|treated as success|resolv(es|ed) with|fake|without (surfacing|throwing)/.test(text);
  return statusSignal && rootCauseSignal;
}

// ---------------------------------------------------------------------------
console.log("G3 battery: independent reviewer");
await preflight();
await ensureSeededBadBranch();
await ensureSeededGoodBranch();

// T1 — negative test on the seeded bad branch.
console.log("\nT1: reviewer vs seeded bad branch (trap #4)");
results.t1 = await runReviewer({ label: "t1-seeded-bad", branch: SEEDED_BRANCH, issueNumber: 4 });
console.log(`  verdict=${JSON.stringify(results.t1.verdict)} (${results.t1.wallSecs}s)`);
results.t1.caught = reasonPointsAtRootCause(results.t1.verdict);

// T2 — positive control on the seeded good twin of trap #4 (see SEEDED_GOOD_RETRY for why it is seeded).
console.log(`\nT2: reviewer vs known-good ${SEEDED_GOOD_BRANCH} (issue #4)`);
results.t2 = await runReviewer({ label: "t2-known-good", branch: SEEDED_GOOD_BRANCH, issueNumber: 4 });
console.log(`  verdict=${JSON.stringify(results.t2.verdict)} (${results.t2.wallSecs}s)`);
results.t2.passed = results.t2.verdict?.verdict === "pass";

// T3 — closed loop on a live target issue through the PRODUCTION entrypoint.
if (t3Issue > 0 && !skipChain) {
  console.log(`\nT3: full chain on issue #${t3Issue} (worker -> review -> gate), production entrypoint`);
  const t0 = Date.now();
  const instance = await spawnInstance({ repo: fixturesRepo, configPath: defaultConfigPath(fixturesRepo) });

  const { startIntakeServer } = await import("../factory/intake.ts");
  const { server: intake, port: intakePort } = await startIntakeServer({
    logPath: join(runDir, `intake-g3-issue-${t3Issue}.jsonl`),
    dispatch: async ({ requestId, content }) => {
      const res = await fetch(`${instance.base}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${instance.token}` },
        body: JSON.stringify({ requestId: requestIdOverride ?? requestId, content }),
      });
      if (!res.ok) throw new Error(`factory /tasks returned ${res.status}`);
      return res.json();
    },
  });

  const issueTitle = await sh("gh", ["api", `repos/${fixturesRepo}/issues/${t3Issue}`, "--jq", ".title"]);
  const issueBody = (await sh("gh", ["api", `repos/${fixturesRepo}/issues/${t3Issue}`, "--jq", '.body // ""'])).trim();
  const event = {
    action: "opened",
    delivery_id: `g3-issue-${t3Issue}-${Date.now()}`,
    repository: { full_name: fixturesRepo },
    issue: { number: t3Issue, title: issueTitle, body: issueBody, labels: [{ name: "agent" }] },
  };
  const delivery = await fetch(`http://127.0.0.1:${intakePort}/webhook/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": event.delivery_id },
    body: JSON.stringify(event),
  });
  if (!(await delivery.json()).accepted) throw new Error("intake rejected issue #4");

  // Wait for open_draft_pr's tool result in the root conversation (it carries
  // either {refused, review} or {prUrl}). 60 min: the 27B worker on trap
  // issue #4 has taken up to ~30+ minutes.
  const deadline = Date.now() + 60 * 60_000;
  let openDraftResult = null;
  const convId = await rootConversationId(instance.base, instance.token);
  while (Date.now() < deadline) {
    try {
      openDraftResult = await waitForToolResult(instance.base, instance.token, convId, "open_draft_pr", () => true, 60_000);
      break;
    } catch { /* not yet — keep waiting */ }
    process.stdout.write(".");
  }
  intake.close();

  const wallSecs = Math.round((Date.now() - t0) / 1000);
  let prExists = false;
  try {
    const out = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", `agent/issue-${t3Issue}`, "--json", "number,url"]);
    prExists = JSON.parse(out || "[]").length > 0;
  } catch { /* none */ }

  let verdict = null;
  try {
    const parsed = JSON.parse(openDraftResult ?? "");
    if (parsed.refused) verdict = parsed.review;
    else if (parsed.prUrl) verdict = { verdict: "pass", note: "open_draft_pr opened the PR" };
  } catch { /* no parsable result */ }

  const gateHeld = verdict ? (verdict.verdict === "fail" ? !prExists : prExists) : false;
  results.t3 = { issueNumber: t3Issue, wallSecs, openDraftResult: openDraftResult?.slice(0, 400) ?? null, verdict, prExists, gateHeld };
  if (!verdict) {
    console.log(`  NO OUTCOME: no open_draft_pr result within the window — issue #${t3Issue} is likely already implemented on main (worker produced nothing to open). Pick an unimplemented target.`);
  } else {
    console.log(`  verdict=${JSON.stringify(verdict)} draftPR=${prExists} gateHeld=${gateHeld} (${wallSecs}s)`);
  }
  await instance.close();
} else {
  const why = skipChain ? "--skip-chain" : "no --t3-issue target (pass --t3-issue <unimplemented issue> to run the closed loop)";
  console.log(`\nT3: skipped (${why})`);
}

// ---------------------------------------------------------------------------
const t1Pass = results.t1.caught;
const t2Pass = results.t2.passed;
// A T3 that ran but produced no verdict is a failure, not a pass — silence is not evidence.
const t3Pass = results.t3 ? results.t3.verdict !== null && results.t3.gateHeld : true;
const gate = t1Pass && t2Pass && t3Pass ? "PASS" : "FAIL";
console.log(`\nG3 ${gate}`);
console.log(`  T1 negative (seeded bad #4): caught=${t1Pass} ${results.t1.verdict ? `(verdict=${results.t1.verdict.verdict})` : "(no verdict)"}`);
console.log(`  T2 positive (${SEEDED_GOOD_BRANCH}, issue #4): passed=${t2Pass} ${results.t2.verdict ? `(verdict=${results.t2.verdict.verdict})` : "(no verdict)"}`);
console.log(`  T3 closed loop (${results.t3 ? `#${results.t3.issueNumber}` : "skipped"}): ${results.t3 ? `verdictOk=${results.t3.verdict !== null}, gateHeld=${results.t3.gateHeld}, draftPR=${results.t3.prExists}` : "not run"}`);

writeFileSync(join(runDir, "g3-results.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log(`results: ${join(runDir, "g3-results.json")}`);
process.exitCode = gate === "PASS" ? 0 : 1;
