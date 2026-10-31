// Phase 6 token accounting: read what a factory instance actually spent, from its durable store.
//
// Why the store and not an endpoint: model usage is recorded per conversation in the core's `pi.usage`
// document (`UsageState`: per-`provider/modelId` buckets plus tool buckets), which makes it durable and
// readable AFTER a run — including runs whose instance is long closed. The alternative (summing `usage`
// off the SSE stream) only exists while something is attached, so a gate that crashed mid-run would
// report nothing. Reading the document also ties the numbers to the same commits as the work they
// describe, rather than to an observer that might have been disconnected.
//
// Storage detail worth knowing before changing this file: `documents.record` holds only doc metadata
// (id/kind/scope); the state lives in `document_revisions.content`. Most revisions are `base`, but the
// core also writes compact `delta` rows in a patch DSL we deliberately do not parse. So this reader uses
// the newest BASE per document and flags the conversation `approximate: true` when a newer revision
// exists — silently under-reporting is worse, especially for numbers quoted in the plan.
//
// Node's sqlite is still experimental (run with --experimental-strip-types like the other gates); callers
// get plain objects, never Database handles.

import { existsSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type UsageCounters = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
};

export type ConversationUsage = {
  conversationId: number;
  /** True for the root (orchestrator) conversation, i.e. one no other conversation owns. */
  isRoot: boolean;
  models: Record<string, UsageCounters>;
  tools: Record<string, UsageCounters>;
  total: UsageCounters;
  /** A revision newer than the newest base exists; totals may understate the real spend. */
  approximate: boolean;
};

export type InstanceUsage = {
  dbPath: string;
  found: boolean;
  conversations: ConversationUsage[];
  byModel: Record<string, UsageCounters>;
  total: UsageCounters;
};

const emptyUsage = (): UsageCounters => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 });

function addInto(into: UsageCounters, u: Partial<UsageCounters> | undefined): void {
  if (!u) return;
  into.input += Number(u.input ?? 0);
  into.output += Number(u.output ?? 0);
  into.cacheRead += Number(u.cacheRead ?? 0);
  into.cacheWrite += Number(u.cacheWrite ?? 0);
  if (typeof u.reasoning === "number") into.reasoning = (into.reasoning ?? 0) + u.reasoning;
  into.totalTokens += Number(u.totalTokens ?? 0);
}

function normalize(raw: unknown): UsageCounters {
  const out = emptyUsage();
  addInto(out, raw as Partial<UsageCounters>);
  return out;
}

/**
 * Find the store for an instance. Accepts the db path itself, an instance root containing
 * `engram-data/agent.sqlite`, or a parent holding one directory per repo slug (what the supervisor and
 * gates create). Returns null when nothing looks like a store.
 */
export function findStoreDb(rootOrDb: string): string | null {
  if (!existsSync(rootOrDb)) return null;
  if (statSync(rootOrDb).isFile()) return rootOrDb;
  const direct = `${rootOrDb.replace(/\/$/, "")}/engram-data/agent.sqlite`;
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(rootOrDb)) {
    const candidate = `${rootOrDb}/${entry}/engram-data/agent.sqlite`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read per-conversation usage from an instance store. A missing or empty store is reported as
 * `found: false` rather than throwing: an unmeasurable run must not turn into a gate failure on the
 * accounting instead of the work.
 */
export function readInstanceUsage(dbPath: string): InstanceUsage {
  const blank: InstanceUsage = { dbPath, found: false, conversations: [], byModel: {}, total: emptyUsage() };
  if (!existsSync(dbPath)) return blank;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Conversations owned by another conversation's task are delegated (worker/reviewer); the rest is
    // root. `documents.owner_id` for a pi.usage doc is the owning conversation id.
    const docs = db
      .prepare(
        `select d.id as doc_id, d.owner_id as conversation_id,
                (select max(r.seq) from document_revisions r where r.document_id = d.id and r.kind = 'base') as base_seq,
                (select max(r.seq) from document_revisions r where r.document_id = d.id) as latest_seq
         from documents d where d.kind = '"pi.usage"' order by d.id asc`,
      )
      .all() as Array<{ doc_id: number; conversation_id: number | null; base_seq: number | null; latest_seq: number | null }>;

    // A conversation is delegated when its own record carries an owner (see conversations.record JSON).
    const delegated = new Set<number>();
    for (const c of db.prepare("select id, record from conversations").all() as Array<{ id: number; record: string }>) {
      try {
        const rec = JSON.parse(String(c.record));
        if (rec?.owner) delegated.add(Number(c.id));
      } catch {
        /* unparseable conversation record: treat as root */
      }
    }

    const result: InstanceUsage = { dbPath, found: true, conversations: [], byModel: {}, total: emptyUsage() };
    for (const doc of docs) {
      if (doc.base_seq === null) continue;
      const row = db
        .prepare("select content from document_revisions where document_id = ? and seq = ?")
        .get(doc.doc_id, doc.base_seq) as { content: string } | undefined;
      if (!row?.content) continue;

      let state: { models?: Record<string, unknown>; tools?: Record<string, unknown> };
      try {
        state = JSON.parse(String(row.content));
      } catch {
        continue; // unparseable revision: skip rather than guess at totals
      }

      const conversationId = Number(doc.conversation_id ?? 0);
      const models: Record<string, UsageCounters> = {};
      const total = emptyUsage();
      for (const [modelKey, usage] of Object.entries(state.models ?? {})) {
        const counters = normalize(usage);
        models[modelKey] = counters;
        addInto(total, counters);
        if (!result.byModel[modelKey]) result.byModel[modelKey] = emptyUsage();
        addInto(result.byModel[modelKey], counters);
      }
      const tools: Record<string, UsageCounters> = {};
      for (const [toolKey, usage] of Object.entries(state.tools ?? {})) {
        const counters = normalize(usage);
        tools[toolKey] = counters; // tool usage has no model identity; counted per conversation only
      }

      result.conversations.push({
        conversationId,
        isRoot: !delegated.has(conversationId),
        models,
        tools,
        total,
        approximate: doc.latest_seq !== null && Number(doc.latest_seq) > Number(doc.base_seq),
      });
      addInto(result.total, total);
    }
    return result;
  } finally {
    db.close();
  }
}

/**
 * Convenience accessor used by gates that only want the headline number: total tokens an instance spent,
 * or null when there is no store to read. Null (not 0) matters — a missing store must never be reported as
 * "spent nothing".
 */
export function totalTokensFor(rootOrDb: string): number | null {
  const dbPath = findStoreDb(rootOrDb);
  if (!dbPath) return null;
  const usage = readInstanceUsage(dbPath);
  return usage.found ? usage.total.totalTokens : null;
}

/** Plain-text summary for gate logs and CI output. */
export function formatUsage(u: InstanceUsage): string {
  if (!u.found) return `usage: no durable store at ${u.dbPath}`;
  const lines = [`usage (${u.dbPath}):`];
  for (const c of u.conversations) {
    if (c.total.totalTokens === 0 && Object.keys(c.models).length === 0) continue;
    lines.push(
      `  conv ${c.conversationId} (${c.isRoot ? "root" : "delegated"}) total=${c.total.totalTokens}` +
        ` in=${c.total.input} out=${c.total.output} cacheRead=${c.total.cacheRead}` +
        `${c.approximate ? " [approximate: newer revisions not applied]" : ""}`,
    );
    for (const [model, m] of Object.entries(c.models)) {
      lines.push(`    ${model}: total=${m.totalTokens} in=${m.input} out=${m.output} cacheRead=${m.cacheRead}`);
    }
  }
  lines.push(
    `  TOTAL tokens=${u.total.totalTokens} (in=${u.total.input} out=${u.total.output} cacheRead=${u.total.cacheRead})`,
  );
  for (const [model, m] of Object.entries(u.byModel)) {
    lines.push(`  model ${model}: ${m.totalTokens}`);
  }
  return lines.join("\n");
}
