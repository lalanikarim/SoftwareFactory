import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findStoreDb, formatUsage, readInstanceUsage } from "../gates/usage.ts";

// Phase 6 token accounting reads the core's durable `pi.usage` documents. These tests build stores with
// the same shape (documents + document_revisions, kinds JSON-quoted like the kernel writes them) so the
// reader is pinned without needing a model endpoint: what must never happen is a total that silently
// under-reports, or a gate crashing because an instance never wrote usage at all.

const dir = mkdtempSync(join(tmpdir(), "usage-accounting-"));

function makeStore(name) {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec(`
    create table conversations (id integer primary key, record text);
    create table documents (id integer primary key, kind text, owner_id integer, record text);
    create table document_revisions (document_id integer, seq integer, kind text, version integer, content text);
  `);
  return { path, db };
}

/** usageState mirrors what pi-durable writes: per provider/model buckets plus tool buckets. */
const usageState = (model, u, tools = {}) =>
  JSON.stringify({ models: { [model]: { cacheWrite: 0, reasoning: 0, cost: {}, ...u } }, tools });

function addConversation(db, id, { owner = null } = {}) {
  db.prepare("insert into conversations (id, record) values (?, ?)").run(
    id,
    JSON.stringify(owner ? { id, owner: { conversationId: owner.conversationId, taskId: owner.taskId } } : { id }),
  );
}

function addUsageDoc(db, docId, conversationId, revisions) {
  db.prepare("insert into documents (id, kind, owner_id, record) values (?, ?, ?, ?)").run(
    docId,
    '"pi.usage"',
    conversationId,
    JSON.stringify({ id: docId, kind: "pi.usage", scope: { kind: "conversation", conversationId } }),
  );
  for (const [seq, kind, content] of revisions) {
    db.prepare("insert into document_revisions (document_id, seq, kind, version, content) values (?, ?, ?, ?, ?)").run(
      docId,
      seq,
      kind,
      1,
      content,
    );
  }
}

// 1. root + delegated conversations aggregate separately and sum to a total.
{
  const { path, db } = makeStore("two-conversations.sqlite");
  addConversation(db, 1);
  addConversation(db, 14, { owner: { conversationId: 1, taskId: 13 } });
  addUsageDoc(db, 4, 1, [[1, "base", usageState("aurora/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF", { input: 100, output: 10, cacheRead: 500, totalTokens: 610 })]]);
  addUsageDoc(db, 17, 14, [[2, "base", usageState("aurora/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF", { input: 1000, output: 200, cacheRead: 9000, totalTokens: 10200 })]]);
  db.close();

  const usage = readInstanceUsage(path);
  assert.equal(usage.found, true);
  assert.equal(usage.conversations.length, 2);
  const root = usage.conversations.find((c) => c.conversationId === 1);
  const worker = usage.conversations.find((c) => c.conversationId === 14);
  assert.equal(root.isRoot, true, "unowned conversation is the root");
  assert.equal(worker.isRoot, false, "conversation owned by a task is delegated");
  assert.equal(root.total.totalTokens, 610);
  assert.equal(worker.total.totalTokens, 10200);
  assert.equal(usage.total.totalTokens, 10810);
  assert.equal(usage.total.input, 1100);
  assert.equal(usage.total.cacheRead, 9500);
  assert.equal(
    usage.byModel["aurora/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF"].totalTokens,
    10810,
    "per-model totals aggregate across conversations",
  );
  console.log("ok - root and delegated conversations aggregate into per-model and instance totals");
}

// 2. multiple models in one conversation stay separate but count once toward the conversation total.
{
  const { path, db } = makeStore("two-models.sqlite");
  addConversation(db, 1);
  addUsageDoc(db, 4, 1, [
    [
      1,
      "base",
      JSON.stringify({
        models: {
          "aurora/model-a": { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
          "aurora/model-b": { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22 },
        },
        tools: {},
      }),
    ],
  ]);
  db.close();

  const usage = readInstanceUsage(path);
  assert.equal(usage.conversations[0].total.totalTokens, 33);
  assert.equal(usage.byModel["aurora/model-a"].totalTokens, 11);
  assert.equal(usage.byModel["aurora/model-b"].totalTokens, 22);
  console.log("ok - per-model buckets stay separate and sum once into the conversation total");
}

// 3. newest base wins (an older base must not be used), and a delta after the newest base is flagged
//    rather than silently ignored — under-reporting cost numbers is the failure mode to avoid.
{
  const { path, db } = makeStore("bases-and-deltas.sqlite");
  addConversation(db, 1);
  addUsageDoc(db, 4, 1, [
    [10, "base", usageState("aurora/m", { input: 1, output: 1, cacheRead: 0, totalTokens: 2 })],
    [20, "base", usageState("aurora/m", { input: 500, output: 50, cacheRead: 4000, totalTokens: 4550 })],
  ]);
  addConversation(db, 2, { owner: { conversationId: 1, taskId: 9 } });
  addUsageDoc(db, 5, 2, [
    [30, "base", usageState("aurora/m", { input: 7, output: 7, cacheRead: 0, totalTokens: 14 })],
    [31, "delta", '[["s",["models"],{}]]'],
  ]);
  db.close();

  const usage = readInstanceUsage(path);
  const root = usage.conversations.find((c) => c.conversationId === 1);
  const delegated = usage.conversations.find((c) => c.conversationId === 2);
  assert.equal(root.total.totalTokens, 4550, "newest base is authoritative");
  assert.equal(root.approximate, false);
  assert.equal(delegated.approximate, true, "a revision newer than the newest base must be disclosed");
  assert.match(formatUsage(usage), /approximate/);
  console.log("ok - newest base wins and unparsed later revisions are flagged approximate");
}

// 4. missing store and empty store are reported, never thrown: accounting must not fail a gate.
{
  const { path, db } = makeStore("empty.sqlite");
  db.close();
  assert.equal(readInstanceUsage(path).found, true);
  assert.equal(readInstanceUsage(path).conversations.length, 0);
  const missing = readInstanceUsage(join(dir, "nope", "agent.sqlite"));
  assert.equal(missing.found, false);
  assert.doesNotThrow(() => formatUsage(missing));
  console.log("ok - empty and missing stores report instead of throwing");
}

// 5. findStoreDb resolves a db path, an instance root, or a parent of repo-slug directories.
{
  const { path, db } = makeStore("located.sqlite");
  db.close();
  assert.equal(findStoreDb(path), path);
  const slugRoot = join(dir, "inst", "lalanikarim_drydock");
  mkdirSync(join(slugRoot, "engram-data"), { recursive: true });
  copyFileSync(path, join(slugRoot, "engram-data", "agent.sqlite"));
  assert.equal(findStoreDb(slugRoot), join(slugRoot, "engram-data", "agent.sqlite"));
  assert.equal(findStoreDb(join(dir, "inst")), join(slugRoot, "engram-data", "agent.sqlite"));
  assert.equal(findStoreDb(join(dir, "absent")), null);
  console.log("ok - findStoreDb resolves db paths, instance roots, and slug parents");
}

rmSync(dir, { recursive: true, force: true });
console.log("\nusage accounting tests passed");
