// Unit test for the factory pipeline extension shape: tool/task registration,
// names, and replay flags — no model calls, no server.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryPipeline } from "./pipeline.ts";

const workDir = mkdtempSync(join(tmpdir(), "factory-pipeline-unit-"));

const ext = factoryPipeline({
  workDir,
  fixturesRepo: "test/repo",
  modelRef: { provider: "openai-completions", modelId: "test-model" },
});

// Tools: the five orchestrator tools + the three reviewer role tools. pr_status is the read-only
// PR-state reader merge_pr's byte-scoped approval depends on (#47).
const toolNames = (ext.tools ?? []).map((t) => t.name).sort();
assert.deepStrictEqual(toolNames, [
  "delegate",
  "git_diff",
  "merge_pr",
  "note_lesson",
  "open_draft_pr",
  "pr_status",
  "run_tests",
  "submit_verdict",
]);

// Tasks: worker + reviewer, both durable task defs.
const taskNames = (ext.tasks ?? []).map((t) => t.definition.name).sort();
assert.deepStrictEqual(taskNames, ["factory.reviewer", "factory.worker"]);

// Replay flags: side-effecting tools are unsafe; read-only ones safe.
const byName = Object.fromEntries((ext.tools ?? []).map((t) => [t.name, t]));
assert.equal(byName.delegate.replay, "unsafe");
assert.equal(byName.open_draft_pr.replay, "unsafe");
assert.equal(byName.merge_pr.replay, "unsafe");
assert.equal(byName.note_lesson.replay, "unsafe");
assert.equal(byName.git_diff.replay, "safe");
assert.equal(byName.run_tests.replay, "safe");

// Gate shape: merge_pr takes {"issueNumber": <int>, "headSha": <string>}. headSha is required
// because approval keys hash the arguments — including it is what makes a human approval cover a
// specific commit instead of whatever the PR points at when the retry runs (#47). Gating is by tool
// name (factory/gate-policy.ts tiers), so widening args cannot un-gate the tool.
const mergeParams = byName.merge_pr.parameters;
assert.deepEqual(Object.keys(mergeParams.properties ?? {}).sort(), ["headSha", "issueNumber"]);
assert.deepEqual([...(mergeParams.required ?? [])].sort(), ["headSha", "issueNumber"]);
assert.equal(byName.pr_status.replay, "safe", "reading PR state must never need an approval");

console.log("factory pipeline extension shape: OK");
