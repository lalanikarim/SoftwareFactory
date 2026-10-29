// Policy enforcement tests: repo registry → capabilities (§5.11).
//   node --experimental-strip-types --test test/repo-enforcement.test.mjs
//
// These exist because "autoMerge: false" was, until now, a comment in a JSON file: nothing in the
// merge path consulted it. Enforcement is capability removal (no merge_pr tool, and a prompt that
// stops at the draft PR), so the tests below assert absence rather than behavior — which is the
// whole point: there is no code path left to forget to check.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryPipeline, orchestratorInstructions, ORCHESTRATOR_INSTRUCTIONS } from "../factory/pipeline.ts";
import { checkRegistryPolicy } from "../fleet/supervisor.ts";

const workDir = mkdtempSync(join(tmpdir(), "repo-enforcement-"));
const opts = { workDir, fixturesRepo: "test/repo", modelRef: { provider: "openai-completions", modelId: "test-model" } };
const toolNames = (o) => (factoryPipeline(o).tools ?? []).map((t) => t.name).sort();

test("default pipeline still offers merge_pr (fixtures are unchanged)", () => {
  assert.ok(toolNames(opts).includes("merge_pr"));
  assert.equal(ORCHESTRATOR_INSTRUCTIONS, orchestratorInstructions());
  assert.match(ORCHESTRATOR_INSTRUCTIONS, /Call merge_pr with \{"issueNumber": <n>\}/);
});

test("autoMerge:false removes the tool rather than gating it", () => {
  const without = toolNames({ ...opts, autoMerge: false });
  assert.ok(!without.includes("merge_pr"), "merge_pr must not be registered when policy forbids merging");
  // Everything else is untouched — a draft-only repo still works end to end up to the PR.
  assert.deepEqual(without.filter((n) => ["delegate", "open_draft_pr", "note_lesson"].includes(n)),
    ["delegate", "note_lesson", "open_draft_pr"]);
  assert.deepEqual(without, toolNames(opts).filter((n) => n !== "merge_pr"));
});

test("the prompt cannot drift from the capability", () => {
  const draftOnly = orchestratorInstructions({ autoMerge: false });
  assert.ok(!draftOnly.includes("merge_pr"), "instructing a call to a tool that is not registered invites the model to find another way");
  assert.match(draftOnly, /STOP here/);
  // The bypass routes have to be named, or "must not merge" gets read as "must not call the tool".
  assert.match(draftOnly, /gh pr merge/);
  assert.match(draftOnly, /no git push to the base branch|git push to the base branch/);
  // Steps 1-5 and the lesson step are identical in both shapes.
  const auto = orchestratorInstructions();
  for (const n of ["1. Call delegate", "3. Call open_draft_pr", "7. Call note_lesson"]) {
    assert.ok(auto.includes(n) && draftOnly.includes(n), `step ${n} must exist in both prompt shapes`);
  }
});

test("the supervisor refuses to run a factory the registry does not allow", () => {
  // Registered + enabled: fine.
  checkRegistryPolicy(["lalanikarim/factory-fixture", "lalanikarim/factory-fixture-2"]);
  // Registered but disabled — drydock's own entry exists to say "not yet".
  assert.throws(() => checkRegistryPolicy(["lalanikarim/drydock"]), /lalanikarim\/drydock is in the repo registry but disabled/);
  // Not registered at all: message lists what IS allowed.
  assert.throws(() => checkRegistryPolicy(["someone/random"]), /someone\/random is not in the repo registry \(known:/);
  // One bad entry poisons the batch (fail before any child spawns, not after).
  assert.throws(() => checkRegistryPolicy(["lalanikarim/factory-fixture", "lalanikarim/drydock"]), /disabled/);
});
