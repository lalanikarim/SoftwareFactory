// Factory gate policy (factory/gate-policy.ts) — the object written to every instance's
// config/gates.json, pinned so production and the boot test cannot drift again (they had:
// the boot test carried a destructivePattern matching {"issueNumber":N}, which also matches
// delegate()'s identical arg shape and stalled unattended runs — plan §5.7, Phase 2 defect (a)).
//
// Also pins the issue #40 posture: merge_pr prompt-tiered, bash declared containment:"sandbox",
// no pattern-level footguns, and the kernel's startup warning actually fires for the declaration.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { instanceGatesConfig } from "../factory/gate-policy.ts";
import { compileGates, evaluateGate } from "../vendor/engram/app/src/extensions/gates.ts";

const policy = instanceGatesConfig();
const serialized = JSON.stringify(policy);

test("gate policy: merge_pr is prompt-tiered and bash declares containment:sandbox", () => {
  assert.deepEqual(policy.tiers.find((t) => t.tool === "merge_pr"), { tool: "merge_pr" }, "no default key → kernel default 'prompt'");
  assert.deepEqual(policy.tiers.find((t) => t.tool === "bash"), { tool: "bash", containment: "sandbox" });
});

test("gate policy: no destructivePatterns and nothing matching a shared arg shape", () => {
  // destructivePatterns is append-only in the kernel, so any entry here weakens nothing but
  // can block unrelated tools that happen to serialize the same way (the delegate() lesson).
  assert.ok(!("destructivePatterns" in policy), "destructivePatterns must stay absent");
  for (const forbidden of ["issueNumber", "delegate", "\\{"]) {
    assert.ok(!serialized.includes(forbidden), `policy must not mention ${forbidden}`);
  }
});

test("gate policy: compiles against the kernel, and the declaration does not weaken static evaluation", () => {
  const g = compileGates(policy);
  assert.equal(g.tiers.get("bash").containment, "sandbox");
  // evaluateGate is containment-agnostic by design (the hook supplies ConversationMeta): a real
  // destructive command must still classify as destructive before suppression is considered.
  assert.equal(evaluateGate(g, "bash", { command: "rm -rf /var" }), "destructive");
  // Declaring the tool means an UNCONTAINED conversation is prompt-gated for every bash call —
  // that is the intended trade (safe-by-stall, see suite D of the N1 suite). Suppression happens
  // only when ConversationMeta.sandbox is true, which the hook supplies.
  assert.equal(evaluateGate(g, "bash", { command: "npm ci >/dev/null 2>&1" }), "prompt");
  assert.equal(evaluateGate(g, "merge_pr", { issueNumber: 7 }), "prompt");
});

test("gate policy: the kernel warns loudly that a containment declaration is active", () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    compileGates(policy);
  } finally {
    console.warn = realWarn;
  }
  const hit = warnings.find((w) => /containment/i.test(w) && /\bbash\b/.test(w));
  assert.ok(hit, `expected a containment warning naming bash, got: ${JSON.stringify(warnings)}`);
});

test("gate policy: main.ts and the boot test consume the shared module (no hand-copied duplicates)", () => {
  for (const file of ["factory/main.ts", "factory/pipeline-boot.test.ts"]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(src, /instanceGatesConfig\(\)/, `${file} must use the shared policy`);
    assert.ok(!/tiers:\s*\[\s*\{\s*tool:\s*"merge_pr"/.test(src), `${file} must not inline a gates.json body`);
  }
});
