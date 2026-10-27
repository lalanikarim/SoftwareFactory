// Phase 6 — measurement & sizing: metrics extraction.
//
// Reads every surviving run database (data/*.sqlite) plus the battery result
// JSONs and emits one table per run: tokens by role (from each conversation's
// pi.usage document), wall time (first→last entry timestamp), tool-call
// counts, errored tool calls, driver submissions, and outcome. No inference
// needed — this is pure post-hoc extraction from committed state, which is
// also why the factory's measurement plan is replayable by construction.
//
// Output: data/phase6-metrics.json + a console table.
// Usage: node 07-measurement.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../vendor/engram/poc/lib/env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
const SKIP_DBS = new Set(["smoke.sqlite"]); // pre-PoC smoke test, not a factory run

// Labels/outcomes for the surviving databases (result JSONs are named per battery,
// not per database). G1's database did not survive; its numbers come from plan §1b.
const RUN_META = {
  "factory": { note: "G3 closed loop — issue #4 trap through review gate → draft PR #9", outcome: "PASS (G3 T3)" },
  "g3-reviewer-t1-seeded-bad": { note: "G3 T1 — seeded bad branch must be caught", outcome: "PASS (verdict fail, correct reason)" },
  "g3-reviewer-t2-known-good": { note: "G3 T2 — known-good branch must pass", outcome: "PASS (verdict pass)" },
  "g4-t1": { note: "G4 T1 — issue #2 stale-branch rework → approve → merge", outcome: "PASS" },
  "g4-t2": { note: "G4 T2 — issue #11 + SIGKILL mid-approval → exactly-once merge", outcome: "PASS" },
  "g5-a": { note: "G5 arm A — baseline, no lessons", outcome: "review PASS; handler-patch pattern (the #11 mistake)" },
  "g5-b": { note: "G5 arm B — same issue, lessons active", outcome: "PASS; root-level fix" },
};

const json = (s) => JSON.parse(s);
// Document columns store JSON-encoded scalars ("\"pi.usage\""), so match the encoded form.
const KIND_USAGE = '"pi.usage"';

function extractDb(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const convs = db.prepare("SELECT id, owner_conversation_id, owner_task_id FROM conversations").all();
    const tasksById = new Map(db.prepare("SELECT id, kind, record FROM tasks").all().map((t) => [t.id, t]));

    // Role per conversation: root (no owner) = orchestrator; otherwise the owning task's kind.
    const roleOf = (c) => {
      if (!c.owner_task_id) return "orchestrator";
      const t = tasksById.get(c.owner_task_id);
      if (!t) return "unknown";
      const kind = json(t.kind).replace(/"/g, "");
      if (kind === "factory.worker") {
        const issueNumber = json(t.record).input?.issueNumber;
        return `worker(issue #${issueNumber})`;
      }
      if (kind === "factory.reviewer") {
        const issueNumber = json(t.record).input?.issueNumber;
        return `reviewer(issue #${issueNumber})`;
      }
      return kind;
    };

    // Per-conversation usage from the latest pi.usage revision.
    const usageByConv = new Map();
    for (const d of db.prepare("SELECT id, owner_id FROM documents WHERE kind = ?").all(KIND_USAGE)) {
      const rev = db
        .prepare("SELECT content FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1")
        .get(d.id);
      if (!rev) continue;
      const state = json(rev.content);
      const sum = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
      for (const m of Object.values(state.models ?? {})) {
        sum.input += m.input ?? 0;
        sum.output += m.output ?? 0;
        sum.cacheRead += m.cacheRead ?? 0;
        sum.totalTokens += m.totalTokens ?? 0;
      }
      usageByConv.set(d.owner_id, sum);
    }

    // Entries: tool-call counts, errored calls, wall time.
    const toolCalls = {};
    let erroredToolCalls = 0;
    let tsMin = Infinity;
    let tsMax = 0;
    for (const r of db.prepare("SELECT record FROM entries").all()) {
      const rec = json(r.record);
      if (rec.kind === "pi.tool-result") {
        const msg = Array.isArray(rec.model) ? rec.model[0] : null;
        if (!msg) continue;
        toolCalls[msg.toolName] = (toolCalls[msg.toolName] ?? 0) + 1;
        if (msg.isError) erroredToolCalls++;
      }
      const m = Array.isArray(rec.model) ? rec.model[0] : null;
      if (m?.timestamp) {
        tsMin = Math.min(tsMin, m.timestamp);
        tsMax = Math.max(tsMax, m.timestamp);
      }
    }

    // Root submissions = driver/human actions on the orchestrator conversation.
    const rootId = convs.find((c) => !c.owner_conversation_id)?.id;
    const submissions = rootId
      ? db.prepare("SELECT request_id FROM submissions WHERE conversation_id = ?").all(rootId).map((r) => json(r.request_id))
      : [];

    // Issue number from any worker task (for labeling).
    const workerTask = convs.map((c) => tasksById.get(c.owner_task_id)).find((t) => t && json(t.kind).includes("factory.worker"));
    const issueNumber = workerTask ? json(workerTask.record).input?.issueNumber ?? null : null;

    return {
      issueNumber,
      wallSecs: tsMax > tsMin ? Math.round((tsMax - tsMin) / 1000) : null,
      conversations: convs.map((c) => ({
        role: roleOf(c),
        ...(usageByConv.get(c.id) ?? { input: 0, output: 0, cacheRead: 0, totalTokens: 0 }),
      })),
      toolCalls,
      erroredToolCalls,
      driverSubmissions: submissions,
    };
  } finally {
    db.close();
  }
}

function main() {
  loadDotEnv(); // pick up PI_MODEL_ID / endpoint config from poc/.env when present
  const runs = [];
  for (const file of readdirSync(dataDir).filter((f) => f.endsWith(".sqlite") && !SKIP_DBS.has(f)).sort()) {
    const label = file.replace(/\.sqlite$/, "");
    let extracted;
    try {
      extracted = extractDb(join(dataDir, file));
    } catch (e) {
      runs.push({ label, error: e.message });
      continue;
    }
    const meta = RUN_META[label] ?? {};
    const totals = extracted.conversations.reduce(
      (acc, c) => {
        acc.input += c.input;
        acc.output += c.output;
        acc.cacheRead += c.cacheRead;
        acc.totalTokens += c.totalTokens;
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0, totalTokens: 0 },
    );
    runs.push({ label, note: meta.note ?? null, ...extracted, totals, outcome: meta.outcome ?? null });
  }

  // Runs whose databases did not survive — numbers from the plan doc / result JSONs.
  const documented = [
    { label: "g1-e2e", note: "G1 — issue #3 → draft PR unattended (database did not survive)", wallSecs: 361, outcome: "PASS (zero intervention)" },
    { label: "g2-battery", note: "G2 — issues #1/#2/#3 evaluated against existing draft PRs (no fresh databases)", outcome: "PASS 3/3, zero human edits" },
  ];

  // Model identity from env/config (PI_MODEL_ID via poc/.env), not a hardcoded host/model string.
  const model = process.env.PI_MODEL_ID ? `${process.env.PI_MODEL_ID} (local, $0)` : "local model ($0)";
  const metrics = { date: new Date().toISOString(), model, runs, documented };
  writeFileSync(join(dataDir, "phase6-metrics.json"), JSON.stringify(metrics, null, 2));

  // Console table.
  for (const r of runs) {
    if (r.error) {
      console.log(`${r.label}: ERROR ${r.error}`);
      continue;
    }
    console.log(`\n=== ${r.label} — issue #${r.issueNumber ?? "?"}${r.note ? ` (${r.note})` : ""} | wall ${r.wallSecs}s | ${r.outcome ?? "no results file"}`);
    for (const c of r.conversations) {
      console.log(`  ${c.role.padEnd(24)} in=${String(c.input).padStart(7)} out=${String(c.output).padStart(6)} cacheRead=${String(c.cacheRead).padStart(7)} total=${String(c.totalTokens).padStart(7)}`);
    }
    console.log(`  ${"TOTAL".padEnd(24)} in=${String(r.totals.input).padStart(7)} out=${String(r.totals.output).padStart(6)} cacheRead=${String(r.totals.cacheRead).padStart(7)} total=${String(r.totals.totalTokens).padStart(7)}`);
    console.log(`  tool calls: ${JSON.stringify(r.toolCalls)} | errored: ${r.erroredToolCalls} | driver submissions: ${r.driverSubmissions.join(", ") || "none"}`);
  }
  for (const d of metrics.documented) {
    console.log(`\n=== ${d.label} — ${d.note} | wall ${d.wallSecs ?? "n/a"}s | ${d.outcome}`);
  }
  console.log(`\nwrote ${join(dataDir, "phase6-metrics.json")}`);
}

main();
