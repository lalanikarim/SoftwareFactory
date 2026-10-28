// N1 — bash DESTRUCTIVE classification (plan §5.7; history in research/n1-bash-destructive-misclassification.md).
//
// Origin: at pin 51b4d39 the destructive floor was evaluated before the tier table (so it gated
// tools with NO tier entry) and matched unanchored substrings of the raw command line, so
// `>/dev/null`, `grep -rn 'shutdown' src/` and SQL inside a string blocked unattended runs.
// Upstream fixed both halves in engram v0.2.0 (issue #53): bash lines are reduced to simple-command
// candidates before matching (quote-aware split on shell operators, /dev/* redirections dropped,
// quoted spans masked unless the head is a shell interpreter/eval), and a tier may declare
// `containment: "sandbox"` to skip the floor in sandboxed conversations.
//
// What each suite guards now:
//   A. the safety floor must keep catching real destruction — permanent guard, never weaken it;
//   B. the four false positives that started N1 stay ungated — regression guard for #53;
//   C. pin characterization for v0.2.0 through the real approval hook (a pin bump that changes
//      classification fails loudly instead of silently invalidating our findings — plan N4);
//   D. containment declaration semantics (the opt-out we may adopt for factory workers);
//   E. the worker prompt still carries its shell-hygiene rules;
//   F. known narrowings introduced by the fix, asserted as-is so tightening them upstream is visible.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileGates,
  evaluateGate,
  applyContainment,
  destructiveCandidates,
  DEFAULT_DESTRUCTIVE_PATTERNS,
} from "../vendor/engram/app/src/extensions/gates.ts";
import { approvalHook } from "../vendor/engram/app/src/extensions/approvals.ts";

// The exact policy factory/main.ts writes into every instance's gates.json.
const FACTORY_GATES = { tiers: [{ tool: "merge_pr" }] };
const gates = compileGates(FACTORY_GATES);
const tierOf = (command, g = gates) => evaluateGate(g, "bash", { command });

// A stub of the hook's execution api: one object satisfying both doc readers (ApprovalRulesDoc
// wants .rules, ConversationMeta wants .sandbox) so the hook path can be driven without a harness.
const hookApi = (sandboxed) => ({ conversationId: 1, snapshot: async () => ({ rules: [], sandbox: sandboxed }) });
const blockFor = async (command, g, sandboxed = false) => {
  const hook = approvalHook(g);
  const beforeTool = hook.handlers?.beforeTool ?? hook.beforeTool;
  const res = await beforeTool({ name: "bash", arguments: { command } }, hookApi(sandboxed), {});
  return res?.block;
};

// ---------------------------------------------------------------- A. safety floor holds

test("A1: the destructive floor applies even though bash has no tier entry", () => {
  assert.equal(gates.tiers.has("bash"), false, "factory policy must not gate bash");
  for (const command of ["rm -rf /tmp/x", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=disk bs=1M", ":(){ :|:& };:"]) {
    assert.equal(tierOf(command), "destructive", `expected destructive: ${command}`);
  }
});

test("A2: the command matcher cannot be bypassed by chaining, prefixes, or quoting tricks", () => {
  for (const command of [
    "ls -la && rm -rf /data",
    "true | git reset --hard HEAD~1",
    "sudo rm -rf /var/tmp/x", // sudo skipped before the head
    "FOO=bar rm -rf /tmp/x", // env assignment skipped before the head
    "find . | xargs rm -rf", // still an executed rm -rf
    `sh -c "rm -rf /tmp/x"`, // interpreter head: quoted text is live code
    "echo $(rm -rf /tmp/x)", // command substitution is never masked
    "echo `rm -rf /tmp/x`", // backticks are never masked
  ]) {
    assert.equal(tierOf(command), "destructive", `expected destructive: ${command}`);
  }
});

test("A3: reboot/shutdown count only as the command being run", () => {
  assert.equal(tierOf("shutdown -h now"), "destructive");
  assert.equal(tierOf("sudo reboot"), "destructive");
  assert.equal(tierOf("grep -rn 'shutdown' src/"), null, "mentioning a word is not running it");
});

test("A4: deleting build artifacts really is destructive and still blocks", () => {
  // Not a false positive: this is `rm -rf`. Workers avoid it via the prompt hygiene rule;
  // suite D2 covers the containment-declaration alternative.
  assert.equal(tierOf("rm -rf node_modules && npm install"), "destructive");
});

// --------------------------- B. the N1 false positives stay fixed (engram #53 regression guard)

test("B1: discarding output to /dev/null is not a destructive write", () => {
  assert.equal(tierOf("npm ci >/dev/null 2>&1"), null);
  assert.equal(tierOf("cd /sandbox && npm test 2>/dev/null"), null);
});

test("B2: a word appearing as search text or in a string is not the action it names", () => {
  assert.equal(tierOf("grep -rn 'shutdown' src/"), null);
  assert.equal(tierOf("cat src/server.mjs | grep reboot"), null);
  assert.equal(tierOf(`node -e "console.log('DROP TABLE x')"`), null);
});

test("B3: writing a script that contains a dangerous line is not running it", () => {
  assert.equal(tierOf("printf '%s\\n' '#!/bin/sh' 'rm -rf /tmp/build' > clean.sh"), null);
});

test("B4: candidate reduction splits simple commands and masks data positions", () => {
  assert.deepEqual(destructiveCandidates("echo hi >/dev/null && grep -rn 'shutdown' src/").length >= 2, true);
  for (const c of destructiveCandidates(`node -e "rm -rf /"`)) {
    assert.doesNotMatch(c, /rm -rf/, "quoted data must not reach the patterns as an action");
  }
});

// --------------------------------- C. pin characterization (engram v0.2.0, hook level)

test("C1: PIN CHARACTERIZATION v0.2.0 — benign commands run, real destruction blocks", async () => {
  for (const command of ["npm ci >/dev/null 2>&1", "grep -rn 'shutdown' src/", "node --test"]) {
    assert.equal(await blockFor(command, gates), undefined, `expected no block: ${command}`);
  }
  const blocked = await blockFor("rm -rf /var", gates);
  assert.ok(blocked, "expected rm -rf /var to block");
  assert.match(blocked, /classified DESTRUCTIVE/);
});

test("C2: PIN CHARACTERIZATION v0.2.0 — the built-in floor is still not removable by config alone", () => {
  const withExtra = compileGates({ ...FACTORY_GATES, destructivePatterns: ["\\bpay_money\\b"] });
  assert.ok(withExtra.destructive.length > DEFAULT_DESTRUCTIVE_PATTERNS.length, "destructivePatterns is append-only");
  // RegExp.source re-escapes "/" as "\/", so compare against the same normalization.
  const src = (p) => new RegExp(p).source;
  for (const p of DEFAULT_DESTRUCTIVE_PATTERNS) {
    assert.ok(withExtra.destructive.some((r) => r.source === src(p)), `built-in pattern still compiled: ${p}`);
  }
});

// ---------------------------------------------- D. containment declaration semantics (#53 opt-out)

const CONTAINED = { tiers: [{ tool: "merge_pr" }, { tool: "bash", containment: "sandbox" }] };

test("D1: the declaration is validated and recorded on the tier", () => {
  const g = compileGates(CONTAINED);
  assert.equal(g.tiers.get("bash").containment, "sandbox");
  assert.throws(() => compileGates({ tiers: [{ tool: "bash", containment: "jail" }] }), /unknown containment/);
});

test("D2: applyContainment only suppresses for the declared tool when actually sandboxed", () => {
  const g = compileGates(CONTAINED);
  assert.equal(applyContainment(g, "bash", "destructive", true), null, "declared + contained → ungated");
  assert.equal(applyContainment(g, "bash", "destructive", false), "destructive", "uncontained keeps the floor");
  assert.equal(applyContainment(g, "merge_pr", "prompt", true), "prompt", "undeclared tool untouched");
});

test("D3: hook honors the declaration for a sandboxed conversation and refuses to for an uncontained one", async () => {
  const g = compileGates(CONTAINED);
  assert.equal(await blockFor("rm -rf /var", g, true), undefined, "sealed sidecar: containment is the protection");
  assert.match(await blockFor("node --test", g, false), /requires human approval/, "declaring a tier gates it when uncontained");
  assert.match(await blockFor("rm -rf /var", g, false), /classified DESTRUCTIVE/);
});

// ------------------------------------------------- E. factory-side stopgap: worker shell hygiene

test("E1: the worker prompt tells the model to avoid the shapes that still block", async () => {
  const { workerPrompt } = await import("../factory/worker.ts");
  const prompt = workerPrompt({ issueNumber: 7, issueText: "Add pagination" });
  for (const needle of ["/dev/null", "rm -rf", "git reset --hard", "git push --force"]) {
    assert.ok(prompt.includes(needle), `worker prompt must mention ${needle}`);
  }
  assert.match(prompt, /destructive/, "and name the guard it is avoiding");
});

// ------------------- F. known narrowings at v0.2.0 (asserted as-is; see the upstream review note)

test("F1: only shell-interpreter heads treat quoted text as live code — other interpreters do not", () => {
  // Characterization, not endorsement: `sh -c` is caught but equivalent payloads through other
  // runtime heads are masked as data. Harmless for factory workers (they run in the sealed
  // sidecar), a real narrowing of the floor for uncontained hosts.
  assert.equal(tierOf(`sh -c "rm -rf /tmp/x"`), "destructive");
  assert.equal(tierOf(`python3 -c "import os; os.system('rm -rf /tmp/x')"`), null);
  assert.equal(tierOf(`node -e "require('fs').rmSync('/tmp/x',{recursive:true})"`), null);
});

test("F2: the redirection drop is broader than output discarding", () => {
  // The pre-v0.2.0 pattern `>\\s*/dev/` also guarded writes onto devices; dropping every
  // /dev/* redirection now lets `> /dev/sda` through while `dd if=` is still caught.
  assert.equal(tierOf("dd if=/dev/zero of=/dev/sda"), "destructive");
  assert.equal(tierOf("echo payload > /dev/sda"), null);
});
