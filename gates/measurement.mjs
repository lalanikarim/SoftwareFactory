// Phase 2 — measurement & sizing: metrics extraction (post-migration).
//
// Reads every surviving instance durable store under GATES_INSTANCES_ROOT
// (default: gates/data/instances) plus emits one table per run: tokens by role
// (from each conversation's pi.usage document), wall time (first→last entry
// timestamp), tool-call counts, errored tool calls, driver submissions, and
// outcome. No inference needed — pure post-hoc extraction from committed state,
// which is also why the factory's measurement plan is replayable by
// construction.
//
// To capture a gate run's stores here, run that gate with
//   GATES_INSTANCES_ROOT=gates/data/instances node --experimental-strip-types gates/gN-...mjs
// (gates/lib.ts spawnInstance honors it). Ad-hoc: pass instance root dirs as
// argv to include them alongside the default scan.
//
// Baseline (pre-migration, plan §1b): 129–433 s and ~81–145K tokens per bounded
// issue on one local GPU (RTX 4090). Drift must be measured and explained.
//
// Output: gates/data/phase6-metrics.json + a console table.
// Usage: node gates/measurement.mjs [instanceRootDir ...]

import { DatabaseSync } from "node:sqlite";
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
const defaultRoot = process.env.GATES_INSTANCES_ROOT ?? join(dataDir, "instances");

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

/** Find agent.sqlite stores: under each root dir, per-repo instance dirs. */
function findStores(rootDirs) {
  const stores = [];
  for (const rootDir of rootDirs) {
    if (!existsSync(rootDir)) continue;
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // <root>/<repo>/engram-data/agent.sqlite — but a root dir may itself be
      // a single instance root (<root>/<repo>/engram-data).
      const direct = join(rootDir, entry.name, "engram-data", "agent.sqlite");
      if (existsSync(direct)) {
        stores.push({ label: `${entry.name}/${entry.name}`, path: direct });
        continue;
      }
      // <root>/<instanceRoot>/<repo>/engram-data/agent.sqlite
      const sub = join(rootDir, entry.name);
      for (const repo of readdirSync(sub, { withFileTypes: true })) {
        if (!repo.isDirectory()) continue;
        const p = join(sub, repo.name, "engram-data", "agent.sqlite");
        if (existsSync(p)) stores.push({ label: `${entry.name}/${repo.name}`, path: p });
      }
    }
  }
  return stores;
}

function main() {
  const rootDirs = process.argv.slice(2).length ? process.argv.slice(2) : [defaultRoot];
  const stores = findStores(rootDirs);
  const runs = [];
  for (const { label, path } of stores.sort((a, b) => a.label.localeCompare(b.label))) {
    let extracted;
    try {
      extracted = extractDb(path);
    } catch (e) {
      runs.push({ label, error: e.message });
      continue;
    }
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
    runs.push({ label, store: path, ...extracted, totals });
  }

  const metrics = { date: new Date().toISOString(), rootDirs, baseline: "129–433 s, ~81–145K tokens per bounded issue (pre-migration)", runs };
  writeFileSync(join(dataDir, "phase6-metrics.json"), JSON.stringify(metrics, null, 2));

  // Console table.
  for (const r of runs) {
    if (r.error) {
      console.log(`${r.label}: ERROR ${r.error}`);
      continue;
    }
    console.log(`\n=== ${r.label} — issue #${r.issueNumber ?? "?"} | wall ${r.wallSecs}s`);
    for (const c of r.conversations) {
      console.log(`  ${c.role.padEnd(24)} in=${String(c.input).padStart(7)} out=${String(c.output).padStart(6)} cacheRead=${String(c.cacheRead).padStart(7)} total=${String(c.totalTokens).padStart(7)}`);
    }
    console.log(`  ${"TOTAL".padEnd(24)} in=${String(r.totals.input).padStart(7)} out=${String(r.totals.output).padStart(6)} cacheRead=${String(r.totals.cacheRead).padStart(7)} total=${String(r.totals.totalTokens).padStart(7)}`);
    console.log(`  tool calls: ${JSON.stringify(r.toolCalls)} | errored: ${r.erroredToolCalls} | driver submissions: ${r.driverSubmissions.join(", ") || "none"}`);
  }
  console.log(`\nwrote ${join(dataDir, "phase6-metrics.json")}`);
}

main();
