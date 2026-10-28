// N1 — bash DESTRUCTIVE misclassification (plan §5.7).
//
// The factory gates exactly one tool (`merge_pr`) and deliberately leaves worker bash
// UNGATED, because containment is the sealed Podman sidecar. The core's approvals extension
// does not honor that: DEFAULT_DESTRUCTIVE_PATTERNS are compiled in unconditionally and
// evaluateGate() consults them BEFORE the tier table, so an ungated tool can still be forced
// to the "destructive" tier — and gates.json can only ADD destructive patterns, never remove
// one. The patterns are plain substring regexes over the whole command line (no shell parsing),
// so ordinary sandbox work matches. A match blocks the call pending a human approval that
// nobody in an unattended fleet is going to give (24 h TTL → auto-deny).
//
// Three suites:
//   A. the safety floor must keep working for genuinely destructive commands (permanent guard);
//   B. known false positives — `todo`, they should not block; they are the acceptance test for
//      the upstream fix, and node reports them as TODO-passed once it lands;
//   C. pin characterization for engram 51b4d39 — asserts today's (wrong) behavior so a pin bump
//      that changes it fails loudly instead of silently invalidating our findings (plan N4).

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileGates, evaluateGate, DEFAULT_DESTRUCTIVE_PATTERNS } from "../vendor/engram/app/src/extensions/gates.ts";
import { approvalHook } from "../vendor/engram/app/src/extensions/approvals.ts";
import { workerPrompt } from "../factory/worker.ts";

// The exact policy factory/main.ts writes into every instance's gates.json.
const FACTORY_GATES = { tiers: [{ tool: "merge_pr" }] };
const gates = compileGates(FACTORY_GATES);
const tierOf = (command) => evaluateGate(gates, "bash", { command });

// ---------------------------------------------------------------- A. safety floor holds

test("A1: the destructive floor applies even though bash has no tier entry", () => {
  assert.equal(gates.tiers.has("bash"), false, "factory policy must not gate bash");
  for (const command of ["rm -rf /tmp/x", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=disk bs=1M"]) {
    assert.equal(tierOf(command), "destructive", `expected destructive: ${command}`);
  }
});

test("A2: compound commands are caught on the destructive segment (guard is not bypassable by chaining)", () => {
  for (const command of ["ls -la && rm -rf /data", "git status; git push --force origin main", "true | git reset --hard HEAD~1"]) {
    assert.equal(tierOf(command), "destructive", `expected destructive: ${command}`);
  }
});

test("A3: ordinary benign commands are not classified", () => {
  for (const command of ["node --test", "npm install", "git status --porcelain", "ls -la && cat package.json", "git add src/x.mjs && git commit -m fix"]) {
    assert.equal(tierOf(command), null, `expected ungated: ${command}`);
  }
});

// --------------------------------------------- B. known false positives (upstream acceptance)

const UPSTREAM = "engram N1: destructive guard is substring-based and not shell-aware";

test("B1: discarding output to /dev/null is not a destructive write", { todo: UPSTREAM }, () => {
  assert.equal(tierOf("npm ci >/dev/null 2>&1"), null);
  assert.equal(tierOf("cd /sandbox && npm test 2>/dev/null"), null);
});

test("B2: a word appearing as search text or in a string is not the action it names", { todo: UPSTREAM }, () => {
  assert.equal(tierOf("grep -rn 'shutdown' src/"), null);
  assert.equal(tierOf("cat src/server.mjs | grep reboot"), null);
  assert.equal(tierOf(`node -e "console.log('DROP TABLE x')"`), null);
});

test("B3: writing a script that contains a dangerous line is not running it", { todo: UPSTREAM }, () => {
  assert.equal(tierOf("printf '%s\\n' '#!/bin/sh' 'rm -rf /tmp/build' > clean.sh"), null);
});

test("B4: cleaning build artifacts inside the sealed sidecar is not destructive", { todo: UPSTREAM }, () => {
  assert.equal(tierOf("rm -rf node_modules && npm install"), null);
});

// ------------------------------------------------- C. pin characterization (engram 51b4d39)

test("C1: PIN CHARACTERIZATION 51b4d39 — benign redirections/strings DO block today", async () => {
  const hook = approvalHook(gates);
  const beforeTool = hook.handlers?.beforeTool ?? hook.beforeTool;
  assert.ok(typeof beforeTool === "function", "approval hook exposes beforeTool");
  const api = { snapshot: async () => null }; // no stored decisions, no allow-rules
  for (const command of ["npm ci >/dev/null 2>&1", "grep -rn 'shutdown' src/"]) {
    const res = await beforeTool({ name: "bash", arguments: { command } }, api, {});
    assert.ok(res?.block, `expected this call to block on ${"51b4d39"}: ${command}`);
    assert.match(res.block, /classified DESTRUCTIVE/, `expected the destructive warning: ${command}`);
  }
});

test("C2: PIN CHARACTERIZATION 51b4d39 — the built-in floor cannot be removed from gates.json", () => {
  // destructivePatterns is append-only; nothing in GatesConfig suppresses a built-in pattern.
  const withExtra = compileGates({ ...FACTORY_GATES, destructivePatterns: ["\\bpay_money\\b"] });
  assert.ok(withExtra.destructive.length > DEFAULT_DESTRUCTIVE_PATTERNS.length);
  // RegExp.source re-escapes "/" as "\/", so compare against the same normalization.
  const src = (p) => new RegExp(p).source;
  for (const p of DEFAULT_DESTRUCTIVE_PATTERNS) {
    assert.ok(withExtra.destructive.some((r) => r.source === src(p)), `built-in pattern still compiled: ${p}`);
  }
});

// ------------------------------- D. factory-side stopgap: worker shell hygiene rules in the prompt

test("D1: the worker prompt tells the model to avoid every known false-positive shape", () => {
  const prompt = workerPrompt({ issueNumber: 7, issueText: "Add pagination" });
  for (const needle of ["/dev/null", "rm -rf", "git reset --hard", "git push --force", "shutdown", "DROP TABLE"]) {
    assert.ok(prompt.includes(needle), `worker prompt must mention ${needle}`);
  }
  assert.match(prompt, /destructive/, "and name the guard it is avoiding");
});
