// Phase 3 / Gate G3 — independent reviewer.
//
//   node 04-reviewer-g3.mjs [--skip-chain]
//
// Tests:
//   T1 (negative): reviewer on the seeded bad branch agent/issue-4-seeded-bad
//      (the "obvious fix" for trap issue #4: a timeout that stops the hang by
//      resolving with a fake error payload — no status surfaced, retries never
//      fire). Must return verdict fail with a reason pointing at the root cause.
//   T2 (positive control): reviewer on known-good agent/issue-1. Must pass.
//   T3 (closed loop): full chain on trap issue #4 via factory + intake.
//      Worker commits; reviewer verdicts; fail => no draft PR + finding reported;
//      pass => draft PR exists. Informational for the gate; records the loop.
//
// Gate G3: T1 caught (fail + substantive reason) AND T2 passed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Harness } from "@earendil-works/pi-durable";
import { localModels, providerId, modelId } from "../../PiDurable/poc/lib/model.mjs";
import { loadFactoryDotEnv, startFactory } from "./lib/factory.mjs";
import { sandboxRegistry } from "./lib/factory-worker.mjs";
import { factoryReviewerTask, makeReviewerRoleTools, factoryReviewTool } from "./lib/factory-reviewer.mjs";

const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

const ctx = BACKGROUND_CONTEXT;
loadFactoryDotEnv();
// Per-run scratch state — start clean so re-runs are not deduped by exactly-once.
for (const f of readdirSync(new URL("./data", import.meta.url).pathname)) {
  if (f.startsWith("g3-reviewer-") && f.endsWith(".sqlite")) rmSync(new URL(`./data/${f}`, import.meta.url).pathname, { force: true });
}
const fixturesRepo = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";
const skipChain = process.argv.includes("--skip-chain");
// Deterministic intake requestIds (issue-<n>) make redeliveries exactly-once no-ops.
// Pass --request-id <id> for a fresh dev re-run of the chain.
const requestIdOverride = (() => {
  const i = process.argv.indexOf("--request-id");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const results = { t1: null, t2: null, t3: null };

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
async function preflight() {
  const models = await fetch(`${process.env.OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
  if (!models.ok) throw new Error(`inference endpoint /models returned ${models.status}`);
  await sh("podman", ["image", "exists", "factory-sandbox:latest"]);
  await sh("gh", ["api", `repos/${fixturesRepo}`, "--jq", ".full_name"]);
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
  const testPath = join(repo, "test/retry.test.mjs");
  const { appendFileSync } = await import("node:fs");
  appendFileSync(testPath, SEEDED_TEST_APPEND);
  // Sanity: the seeded branch's own suite must pass (that's what makes it a trap).
  await sh("node", ["--test"], { cwd: repo });
  await sh("git", ["-C", repo, "add", "src/retry.mjs", "test/retry.test.mjs"]);
  await sh("git", ["-C", repo, "-c", "user.name=software-factory-poc", "-c", "user.email=factory@localhost", "commit", "-q", "-m", "Seed: bounded-timeout fix for hanging upstreams (review fixture)"]);
  await sh("git", ["-C", repo, "push", "--quiet", "origin", "HEAD:refs/heads/" + SEEDED_BRANCH]);
  console.log(`seeded bad branch ${SEEDED_BRANCH} pushed (own suite passes — it is a trap)`);
}

// ---------------------------------------------------------------------------
// Isolated reviewer run on its own harness/sqlite.
// ---------------------------------------------------------------------------
async function runReviewer({ label, branch, issueNumber }) {
  const base = new URL(".", import.meta.url).pathname;
  const workDir = join(base, "work");
  const modelRef = { provider: await providerId(), modelId: await modelId() };
  const reviewerTaskDef = factoryReviewerTask({ workDir, fixturesRepo });
  const reviewerRoleTools = makeReviewerRoleTools({ workDir });
  const reviewTool = factoryReviewTool({ taskDef: reviewerTaskDef, modelRef });

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(defineExtension({ name: "factory-reviewer", tools: [reviewTool, ...reviewerRoleTools], tasks: [reviewerTaskDef] }));

  const harness = await Harness.open(
    await openNodeSqliteStorage(join(base, `data/g3-reviewer-${label}.sqlite`)),
    {
      models: await localModels(),
      registry,
      env: (target) => sandboxRegistry.get(target.conversationId) ?? new NodeExecutionEnv({ cwd: workDir }),
    },
    ctx,
  );
  harness.resume();

  const root = await harness.root(ctx, {
    agent: {
      model: modelRef,
      thinkingLevel: "medium",
      tools: [reviewTool],
      instructions:
        `You run one review per message. Call review with the branch and issue number given in the message, wait for its result, then answer with exactly the verdict JSON the tool returned (no other text).`,
    },
  });

  const t0 = Date.now();
  const sub = await root.submit(
    { type: "input", content: `Review branch ${branch} for issue #${issueNumber}. Call review({branch: "${branch}", issueNumber: ${issueNumber}}).`, requestId: `g3-${label}` },
    ctx,
  );
  const settled = await sub.wait(ctx);
  const wallSecs = Math.round((Date.now() - t0) / 1000);

  // Ground truth: the reviewer task's durable outcome (not the root's prose).
  const page = await root.commit((tx) => tx.scanTasks({ kind: "factory.reviewer" }, 10), ctx);
  const taskRecords = page.items;
  const verdict = taskRecords.length > 0 ? taskRecords[taskRecords.length - 1].state.outcome?.result : null;

  for (const sbx of [...sandboxRegistry.values()]) await sbx.cleanup(ctx);
  await harness.close(ctx);
  return { label, branch, issueNumber, wallSecs, settledStatus: settled.status, verdict };
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

// T1 — negative test on the seeded bad branch.
console.log("\nT1: reviewer vs seeded bad branch (trap #4)");
results.t1 = await runReviewer({ label: "t1-seeded-bad", branch: SEEDED_BRANCH, issueNumber: 4 });
console.log(`  verdict=${JSON.stringify(results.t1.verdict)}`);
results.t1.caught = reasonPointsAtRootCause(results.t1.verdict);

// T2 — positive control on known-good agent/issue-1.
console.log("\nT2: reviewer vs known-good agent/issue-1");
results.t2 = await runReviewer({ label: "t2-known-good", branch: "agent/issue-1", issueNumber: 1 });
console.log(`  verdict=${JSON.stringify(results.t2.verdict)}`);
results.t2.passed = results.t2.verdict?.verdict === "pass";

// T3 — closed loop on trap issue #4 through the full factory chain.
if (!skipChain) {
  console.log("\nT3: full chain on trap issue #4 (worker -> review -> gate)");
  const t0 = Date.now();
  const factory = await startFactory({ port: 9602 });
  const intakeLog = new URL(`./data/intake-g3-issue-4.jsonl`, import.meta.url).pathname;
  const { startIntakeServer } = await import("./lib/intake.mjs");
  const { server: intake, port: intakePort } = await startIntakeServer({
    logPath: intakeLog,
    dispatch: async ({ requestId, content }) => {
      const res = await fetch(`http://127.0.0.1:${factory.port}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: requestIdOverride ?? requestId, content }),
      });
      if (!res.ok) throw new Error(`factory /tasks returned ${res.status}`);
      return res.json();
    },
  });

  // factory.sqlite is shared across runs: baseline the task ids before delivery,
  // then only consider issue-#4 tasks created after it.
  const baseline = await factory.rootConversation().commit(
    (tx) => Promise.all([
      tx.scanTasks({ kind: "factory.worker" }, 200),
      tx.scanTasks({ kind: "factory.reviewer" }, 200),
    ]).then(([w, r]) => Math.max(0, ...[...w.items, ...r.items].map((t) => t.id))),
    ctx,
  );
  const pick = (items) => items.find((t) => t.input?.issueNumber === 4 && t.id > baseline) ?? null;

  const issueTitle = await sh("gh", ["api", `repos/${fixturesRepo}/issues/4`, "--jq", ".title"]);
  const issueBody = (await sh("gh", ["api", `repos/${fixturesRepo}/issues/4`, "--jq", '.body // ""'])).trim();
  const event = {
    action: "opened",
    delivery_id: `g3-issue-4-${Date.now()}`,
    repository: { full_name: fixturesRepo },
    issue: { number: 4, title: issueTitle, body: issueBody, labels: [{ name: "agent" }] },
  };
  const delivery = await fetch(`http://127.0.0.1:${intakePort}/webhook/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": event.delivery_id },
    body: JSON.stringify(event),
  });
  if (!(await delivery.json()).accepted) throw new Error("intake rejected issue #4");

  // Wait until this run's worker AND reviewer tasks are terminal (or timeout).
  const deadline = Date.now() + 25 * 60_000;
  let workerState = null, reviewerState = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    const page = await factory.rootConversation().commit(
      (tx) => tx.scanTasks({ kind: "factory.worker" }, 50).then(async (w) => ({ w, r: await tx.scanTasks({ kind: "factory.reviewer" }, 50) })),
      ctx,
    );
    workerState = pick(page.w.items);
    reviewerState = pick(page.r.items);
    const terminal = (s) => s && ["completed", "failed", "aborted"].includes(s.state.outcome?.status);
    if (terminal(workerState) && (reviewerState === null || terminal(reviewerState))) break;
    process.stdout.write(".");
  }
  intake.close();

  const wallSecs = Math.round((Date.now() - t0) / 1000);
  let prExists = false;
  try {
    const out = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", "agent/issue-4", "--json", "number,url"]);
    prExists = JSON.parse(out || "[]").length > 0;
  } catch { /* none */ }

  const verdict = reviewerState?.state.outcome?.result ?? null;
  const gateHeld = verdict ? (verdict.verdict === "fail" ? !prExists : prExists) : false;
  results.t3 = { wallSecs, workerOutcome: workerState?.state.outcome?.status ?? null, verdict, prExists, gateHeld };
  console.log(`  worker=${results.t3.workerOutcome} verdict=${JSON.stringify(verdict)} draftPR=${prExists} gateHeld=${gateHeld} (${wallSecs}s)`);
  await factory.close();
} else {
  console.log("\nT3: skipped (--skip-chain)");
}

// ---------------------------------------------------------------------------
const t1Pass = results.t1.caught;
const t2Pass = results.t2.passed;
const gate = t1Pass && t2Pass ? "PASS" : "FAIL";
console.log(`\nG3 ${gate}`);
console.log(`  T1 negative (seeded bad #4): caught=${t1Pass} ${results.t1.verdict ? `(verdict=${results.t1.verdict.verdict})` : "(no verdict)"}`);
console.log(`  T2 positive (known-good #1): passed=${t2Pass} ${results.t2.verdict ? `(verdict=${results.t2.verdict.verdict})` : "(no verdict)"}`);
if (results.t3) console.log(`  T3 closed loop (#4): gateHeld=${results.t3.gateHeld}, worker=${results.t3.workerOutcome}, draftPR=${results.t3.prExists}`);

writeFileSync(new URL("./data/g3-results.json", import.meta.url).pathname, JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
process.exitCode = gate === "PASS" ? 0 : 1;
