// Phase 5 battery — Gate G5: feedback loop ("the same mistake doesn't recur").
//
// The anchor finding (from a real prior run): on issue #11 (PR #12) the worker
// fixed "validation errors surface as 500" with a HANDLER-LEVEL patch —
// `catch (e) { if (e instanceof TypeError) throw Object.assign(new Error(...), { statusCode: 400 }) }`
// in createInvoice — instead of giving the error class a statusCode like
// InvoiceNotFoundError already has. The independent reviewer flagged exactly
// this fragility ("if store.add ever throws a non-TypeError validation error,
// it would again surface as 500").
//
// Similar issue for the re-run: fixture issue #13 — invalid status transitions
// return 500 (InvalidTransitionError has no statusCode) against the README's
// 4xx spec. The naive fix is the same handler-level patch; the corrected
// behavior is a root-level fix (statusCode on the error class).
//
// Experiment:
//   Step A (baseline, lessons file empty): work directive for issue #13.
//     Record the reviewer verdict + objective classification of the fix pattern
//     (rootFix vs handlerPatch) from a fresh clone's diff.
//   Lesson: ensure one standing lesson is recorded via note_lesson (the
//     orchestrator does this on refusal per its instructions; if it skipped,
//     the battery — acting as the human driver — submits a trusted instruction
//     to record the distilled finding. This is counted as an intervention.)
//   Step B (lessons active): fresh database, same lessons file, work directive
//     for issue #13 again. Expect review PASS and objective root-level fix.
//
// G5 passes when: the lesson was recorded durably AND step B's review passed
// AND step B's diff shows the root-level fix (no handler patch). Attribution
// strength is reported separately: "strong" if step A exhibited the handler
// patch that then disappeared, "single-trial" otherwise.
//
// Usage: node 06-feedback-g5.mjs   (env: G5_ISSUE=13, G5_PORT_A=9651, G5_PORT_B=9652)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadFactoryDotEnv } from "./lib/factory.mjs";
import { loadDotEnv } from "../../engram/poc/lib/env.mjs";

const pexec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
loadFactoryDotEnv(__dirname);
loadDotEnv();
const root = join(__dirname, "..");
const dataDir = join(__dirname, "data");
const fixturesRepo = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";
const ghToken = process.env.FACTORY_GITHUB_TOKEN ?? "";

const ISSUE = Number(process.env.G5_ISSUE ?? 13);
const PORT_A = Number(process.env.G5_PORT_A ?? 9651);
const PORT_B = Number(process.env.G5_PORT_B ?? 9652);
const LESSONS_FILE = join(dataDir, "g5-lessons.md");

// Distilled lesson used by the human-driver fallback when the orchestrator does
// not record one itself. Derived from the PR #12 reviewer concern (issue #11).
const FALLBACK_LESSON =
  `Fix error-status bugs at the root: give the thrown error class a statusCode property (as InvoiceNotFoundError does for issue #11), not an instanceof/catch-and-rethrow patch in the route handler.`;

let failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
}

async function http(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function waitHealthy(base, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await http(base, "GET", "/health");
      if (r.status === 200 && r.json?.status === "ok") return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function portFree(port) {
  const socket = await new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
  return socket;
}

function spawnFactory({ port, dbPath, env = {} }) {
  const child = spawn(process.execPath, [join(__dirname, "lib", "factory.mjs"), String(port), dbPath], {
    cwd: __dirname,
    env: { ...process.env, FACTORY_LESSONS_FILE: LESSONS_FILE, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[factory:${port}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[factory:${port}!err] ${d}`));
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    kill: () => child.kill("SIGTERM"),
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1))),
  };
}

async function submit(base, directive) {
  const r = await http(base, "POST", "/tasks", { requestId: `g5-${crypto.randomUUID()}`, content: directive });
  if (r.status !== 202) throw new Error(`submit failed: ${r.status} ${r.text}`);
  return r.json;
}

/** Poll /tool-results until an entry for `toolName` matches `match(text)`, or timeout. */
async function waitForToolResult(base, { toolName, match, timeoutMs, pollMs = 3000 }) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await http(base, "GET", "/tool-results?n=40");
      if (r.status === 200 && Array.isArray(r.json?.results)) {
        last = r.json.results;
        for (const e of last) {
          if (e.toolName === toolName && match(e.text ?? "")) return e;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { timeout: true, last };
}

const parseJsonLoose = (text) => {
  const i = text.indexOf("{");
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i)); } catch { return null; }
};

/** Objective classification of the fix on agent/issue-N vs origin/main (fresh clone). */
async function classifyFix({ issueNumber }) {
  const dir = mkdtempSync(join(tmpdir(), "g5-clone-"));
  try {
    await pexec("git", ["clone", "-q", `https://github.com/${fixturesRepo}.git`, dir], { timeout: 90_000 });
    const branch = `origin/agent/issue-${issueNumber}`;
    await pexec("git", ["fetch", "-q", "origin", `agent/issue-${issueNumber}:refs/remotes/${branch}`], { cwd: dir, timeout: 60_000 });
    const storeDiff = (await pexec("git", ["diff", `origin/main..${branch}`, "--", "src/store.mjs"], { cwd: dir })).stdout;
    const invoicesDiff = (await pexec("git", ["diff", `origin/main..${branch}`, "--", "src/invoices.mjs"], { cwd: dir })).stdout;
    // root-level fix: a statusCode=4xx line added to src/store.mjs (error class carries the status)
    const rootFix = /^\+\s+this\.statusCode\s*=\s*4\d\d/m.test(storeDiff);
    // handler-level patch: new instanceof or catch-with-status in the route handler
    const handlerPatch = /instanceof/.test(invoicesDiff) || (/^\+.*catch/m.test(invoicesDiff) && /400|409|statusCode/.test(invoicesDiff));
    return {
      rootFix,
      handlerPatch,
      storeDiff: storeDiff.slice(0, 1500),
      invoicesDiff: invoicesDiff.slice(0, 1500),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

async function runStep({ label, port, dbPath, issueNumber }) {
  const f = spawnFactory({ port, dbPath });
  let draftJson = null;
  let noteLessonResult = null;
  let lessonIntervention = false;
  try {
    if (!(await waitHealthy(f.base))) throw new Error(`${label}: factory unhealthy`);
    await submit(f.base, `Work issue number: ${issueNumber}`);

    // open_draft_pr settles with either a refusal (review failed) or a prUrl.
    const draft = await waitForToolResult(f.base, {
      toolName: "open_draft_pr",
      match: (t) => t.includes('"refused": true') || t.includes('"prUrl"'),
      timeoutMs: 15 * 60_000,
    });
    if (draft.timeout) throw new Error(`${label}: open_draft_pr did not settle in 15m`);
    draftJson = parseJsonLoose(draft.text) ?? {};

    // If refused: the orchestrator should record a lesson via note_lesson.
    if (draftJson.refused) {
      const rec = await waitForToolResult(f.base, { toolName: "note_lesson", match: () => true, timeoutMs: 120_000 });
      if (!rec.timeout) noteLessonResult = rec;
    }

    // Human-driver fallback: ensure exactly one lesson is on the books.
    const lessonsBefore = existsSync(LESSONS_FILE) ? readFileSync(LESSONS_FILE, "utf8").trim() : "";
    if (!lessonsBefore) {
      await submit(f.base, `Record this standing lesson with note_lesson now: "${FALLBACK_LESSON}"`);
      const rec = await waitForToolResult(f.base, { toolName: "note_lesson", match: () => true, timeoutMs: 180_000 });
      if (rec.timeout) throw new Error(`${label}: lesson could not be recorded via note_lesson`);
      lessonIntervention = true;
    }

    // Let the run settle (final answer), then stop.
    await sleep(15_000);
  } finally {
    f.kill();
  }
  const code = await Promise.race([f.exited, sleep(10_000).then(() => -9)]);

  return { label, draftJson, noteLessonResult: noteLessonResult ? parseJsonLoose(noteLessonResult.text) : null, lessonIntervention, exitCode: code };
}

async function main() {
  console.log(`G5 feedback loop — issue #${ISSUE}, lessons file: ${LESSONS_FILE}`);
  const t0 = Date.now();

  // Preflight.
  try {
    await fetch(`${process.env.OPENAI_BASE_URL ?? ""}/models`, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.error(`inference unreachable: ${e.message}`);
    process.exit(2);
  }
  for (const port of [PORT_A, PORT_B]) {
    if (await portFree(port)) {
      console.error(`port ${port} is already in use — kill stale factory processes and retry`);
      process.exit(2);
    }
  }
  rmSync(LESSONS_FILE, { force: true });

  // Step A — baseline, no lessons.
  const a = await runStep({ label: "A", port: PORT_A, dbPath: join(dataDir, "g5-a.sqlite"), issueNumber: ISSUE });
  console.log(`step A settled: refused=${a.draftJson.refused ?? "?"} prUrl=${a.draftJson.prUrl ?? "-"} note_lesson=${a.noteLessonResult?.recorded ?? "-"}`);

  // Objective classification of step A's fix (only if a branch exists).
  let classifyA = null;
  try {
    classifyA = await classifyFix({ issueNumber: ISSUE });
    console.log(`step A fix pattern: rootFix=${classifyA.rootFix} handlerPatch=${classifyA.handlerPatch}`);
  } catch (e) {
    console.log(`step A classification unavailable (${e.message}) — likely no branch (refused run)`);
  }

  const lessons = existsSync(LESSONS_FILE) ? readFileSync(LESSONS_FILE, "utf8").trim() : "";
  if (!lessons) fail("no lesson recorded after step A");

  // Step B — same issue, lessons active, fresh database.
  const b = await runStep({ label: "B", port: PORT_B, dbPath: join(dataDir, "g5-b.sqlite"), issueNumber: ISSUE });
  console.log(`step B settled: refused=${b.draftJson.refused ?? "?"} prUrl=${b.draftJson.prUrl ?? "-"}`);

  let classifyB = null;
  try {
    classifyB = await classifyFix({ issueNumber: ISSUE });
    console.log(`step B fix pattern: rootFix=${classifyB.rootFix} handlerPatch=${classifyB.handlerPatch}`);
  } catch (e) {
    fail(`step B classification failed: ${e.message}`);
  }

  // G5 checks.
  if (!lessons) fail("lesson not recorded durably");
  if (b.draftJson.refused) fail(`step B review did not pass: ${JSON.stringify(b.draftJson).slice(0, 400)}`);
  if (!b.draftJson.prUrl) fail("step B produced no PR");
  if (classifyB && !classifyB.rootFix) fail("step B fix is not root-level (no statusCode added to the error class in src/store.mjs)");
  if (classifyB && classifyB.handlerPatch) fail("step B still uses a handler-level patch (instanceof/catch-and-rethrow)");

  const attribution = classifyA?.handlerPatch ? "strong (baseline exhibited the handler patch; it did not recur)" : "single-trial (baseline did not exhibit the pattern; corrected behavior verified once with lessons active)";
  const passed = failures.length === 0;
  const result = {
    gate: "G5",
    issueNumber: ISSUE,
    anchorFinding: "PR #12 (issue #11) reviewer concern: handler-level instanceof patch instead of statusCode on the error class",
    lessonsFile: LESSONS_FILE,
    lesson: lessons.split("\n").map((l) => l.trim()).filter(Boolean),
    stepA: { refused: a.draftJson.refused ?? null, prUrl: a.draftJson.prUrl ?? null, noteLesson: a.noteLessonResult, lessonIntervention: a.lessonIntervention, fixPattern: classifyA ? { rootFix: classifyA.rootFix, handlerPatch: classifyA.handlerPatch } : null, diffExcerpts: classifyA ? { storeDiff: classifyA.storeDiff, invoicesDiff: classifyA.invoicesDiff } : null },
    stepB: { refused: b.draftJson.refused ?? null, prUrl: b.draftJson.prUrl ?? null, lessonIntervention: b.lessonIntervention, fixPattern: classifyB ? { rootFix: classifyB.rootFix, handlerPatch: classifyB.handlerPatch } : null, diffExcerpts: classifyB ? { storeDiff: classifyB.storeDiff, invoicesDiff: classifyB.invoicesDiff } : null },
    attribution,
    failures,
    wallSecs: Math.round((Date.now() - t0) / 1000),
    passed,
  };
  writeFileSync(join(dataDir, "g5-results.json"), JSON.stringify(result, null, 2));
  console.log(`\nGATE G5: ${passed ? "PASS" : "FAIL"} (${result.wallSecs}s) attribution=${attribution}`);
  if (!passed) console.log(JSON.stringify(failures, null, 2));
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error("G5 battery error:", e);
  process.exit(1);
});
