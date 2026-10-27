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

// Tools: the four orchestrator tools + the three reviewer role tools.
const toolNames = (ext.tools ?? []).map((t) => t.name).sort();
assert.deepStrictEqual(toolNames, [
  "delegate",
  "git_diff",
  "merge_pr",
  "note_lesson",
  "open_draft_pr",
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

// Gate shape: merge_pr's parameter is exactly {"issueNumber": <int>} so the
// instance gates.json destructive pattern matches every real call.
const mergeParams = byName.merge_pr.parameters;
assert.deepEqual(Object.keys(mergeParams.properties ?? {}).sort(), ["issueNumber"]);

console.log("factory pipeline extension shape: OK");
