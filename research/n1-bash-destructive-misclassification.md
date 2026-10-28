# N1 — Bash DESTRUCTIVE misclassification (root cause + fix)

**Compiled:** 2026-10-28 · **Core pin:** `lalanikarim/engram@51b4d39076edb1653cb55ec14aa8be032384b8ac` (`51b4d39`) · **Status:** root-caused; factory-side stopgap shipped; upstream fix proposed (not yet filed)

Companion to `multi-repo-factory-plan.md` §5.7 item N1 — the only known blocker to fully unattended fleets.

---

## 1. Symptom

During M2 and M4 live runs, worker `bash` calls were blocked with:

```
BLOCKED: "bash" requires human approval before it can run.
This action was classified DESTRUCTIVE. It will run only if the user explicitly acknowledges the risk.
Approval request: {"key":"586245f6777a","tool":"bash","args":{"command":"npm ci >/dev/null 2>&1"},"tier":"destructive"}
```

…even though the factory's per-instance `gates.json` gates **one** tool (`merge_pr`) and deliberately leaves worker bash ungated — containment is the sealed Podman sidecar (`network=none`, workspace-only mount), see `factory/main.ts:104-111`. Workers recovered by rephrasing the command; an unattended run would stall until the 24 h approval TTL auto-denies it.

## 2. Reproduction (deterministic, no model, no container)

```bash
node --experimental-strip-types --test test/n1-destructive-classification.test.mjs
```

Classifies commands with the vendored core's own `evaluateGate()` and drives the real
`approvalHook().beforeTool` using **the exact policy `factory/main.ts` writes** (`{tiers:[{tool:"merge_pr"}]}`).

Verified classification matrix (pin `51b4d39`, factory policy — `bash` has **no** tier entry):

| Command | Tier returned | Verdict |
|---|---|---|
| `node --test` | *(ungated)* | correct |
| `npm install` | *(ungated)* | correct |
| `ls -la && cat package.json` | *(ungated)* | correct |
| `git add src/x.mjs && git commit -m fix` | *(ungated)* | correct |
| `npm ci >/dev/null 2>&1` | **destructive** | **false positive** |
| `cd /tmp/w/issue-2 && npm test 2>/dev/null` | **destructive** | **false positive** |
| `grep -rn 'shutdown' src/` | **destructive** | **false positive** |
| `cat src/server.mjs \| grep reboot` | **destructive** | **false positive** |
| `node -e "console.log('DROP TABLE x')"` | **destructive** | **false positive** |
| `printf '%s\n' '#!/bin/sh' 'rm -rf /tmp/build' > clean.sh` | **destructive** | **false positive** |
| `rm -rf node_modules && npm install` | **destructive** | debatable in a sealed, throwaway sidecar |
| `rm -rf /var` / `mkfs.ext4 /dev/sda1` / `dd if=…` / `git push --force` / `git reset --hard` | **destructive** | correct (the floor must stay) |

The M2/M4 observations were the redirection family: `>/dev/null` is by far the highest-frequency trigger, because it is idiomatic in exactly the setup/verification commands a worker writes.

## 3. Root cause — two independent defects

### D1 · Scope: the built-in floor applies to *ungated* tools

`vendor/engram/app/src/extensions/gates.ts:97-103` evaluates destructive patterns **before** consulting the tier table, and returns `"destructive"` regardless of whether the tool has a gate entry at all:

```ts
export function evaluateGate(gates, tool, args) {
  const text = gateArgText(tool, args);
  if (gates.destructive.some((p) => p.test(text))) return "destructive";  // ← before any tier lookup
  const spec = gates.tiers.get(tool);
  if (!spec) return null;                                                  // ← "ungated" is reached too late
  …
}
```

The floor is compiled in unconditionally (`gates.ts:27-45`, `:82`), and `GatesConfig.destructivePatterns` is **append-only** — the type comment says "added to the built-in list (never removed)". So a consumer that declares bash ungated has **no configuration path** to an unblocked bash. Confirmed by test C2.

This contradicts the upstream design doc (`vendor/engram/docs/plans/approvals.md`, hook evaluation order): step 1 reads "any **gated** call whose serialized args match a destructivePattern", step 4 reads "**Ungated tools: unchanged**". It is nonetheless *tested* behavior upstream (`app/test/gates.test.ts:46` asserts `db_exec` — a tool with no tier — is destructive), so it is deliberate hardening, not an accident. **The factory's containment model and the core's safety floor are in direct conflict and must be reconciled by an explicit opt-out, not by hoping the regexes miss.**

### D2 · Matching: substring regex over the whole command line, no shell parsing

`gateArgText()` hands the raw command string to unanchored regexes (`gates.ts:50-56`, `:28-45`). Consequences:

| Pattern | Why it over-matches |
|---|---|
| `>\s*/dev/` | matches **output redirection**, including `>/dev/null`, `2>/dev/null`. Discarding stdout is not a write to a device; this single pattern accounts for most real blocks. |
| `\breboot\b`, `\bshutdown\b` | match anywhere: search arguments, string literals, filenames, log content (`grep -rn shutdown src/`). |
| `\bDROP\s+(TABLE\|DATABASE\|INDEX)\b`, `\bTRUNCATE\s+\w+` | match inside quoted strings and heredocs. The factory's own workload is invoice/DB fixtures — SQL text in source and shell strings is normal. |
| all patterns | evaluated against the **whole compound command**: one matching segment (or one matching word in a here-string) poisons the command, and no `autoPatterns` can rescue it because destructive wins by design. |

No shell tokenization means the guard cannot distinguish *performing* an action from *mentioning* it: writing a script that contains `rm -rf` is blocked exactly like running it (B3).

### Ruled out: renaming our own bash tool

Registering the sandbox shell under a different tool name does **not** help — verified: `evaluateGate(gates, "run_shell", { command: "npm ci >/dev/null 2>&1" })` and `{ cmd: … }` both return `"destructive"`, because non-bash args are canonicalized to JSON and the patterns are unanchored, so the command text still appears in the matched string.

## 4. Options considered

| Option | What | Verdict |
|---|---|---|
| **A — upstream fix** (engram) | (1) shell-aware matching; (2) an explicit containment opt-out for consumers that sandbox execution | **Do this.** Only place the conflict can actually be resolved. Draft in §6. |
| **B — factory auto-approver for `tool === "bash"`** | Supervisor polls `GET /approvals` per instance and approves bash-tier requests (never `merge_pr`) | **Rejected as primary.** The hook does not pause a turn awaiting approval — it blocks and instructs the agent *not to retry*, so throughput depends on the model re-issuing an identical call after the poller acts. It also converts "bash is architecturally ungated" into "bash is gated then rubber-stamped", which weakens the audit story for no real safety gain inside a sealed sidecar. |
| **C — worker prompt shell hygiene** (factory-side stopgap) | Tell workers the shapes that trip the guard and forbid them | **Shipped** (§5). Cheap, zero core change, drops incidence to ~zero for our own workloads. It is a workaround: it constrains the model instead of fixing the classifier, and it does nothing for a repo whose legitimate build commands need `>/dev/null`. |
| — rename the bash tool | see above | Ruled out (verified). |
| — add `autoPatterns` for bash in `gates.json` | try to auto-allow common commands | Cannot work: destructive is evaluated before tiers, so an auto pattern never gets a chance. |

## 5. Shipped stopgap (this branch)

- `factory/worker.ts` — `workerPrompt()` gains a **Shell hygiene** working rule: no `/dev/null` redirection, no `rm -rf` / `git reset --hard` / `git push --force`, prefer read/edit tools over grep/cat pipelines, never inline SQL DDL or the words `shutdown`/`reboot` in a shell string. The rule names the guard so the model understands *why* (and reviewers have no shell tools, so they need nothing).
- `test/n1-destructive-classification.test.mjs` — four suites: **A** the safety floor must keep catching real destruction (permanent guard), **B** the false positives as node `todo` tests (they are the acceptance test for the upstream fix; they turn TODO-passed when it lands), **C** pin characterization for `51b4d39` so a pin bump that changes behavior fails loudly (feeds plan item N4), **D** the worker prompt keeps carrying every hygiene rule. Wired into `npm test`; suite is green with 4 documented TODOs.

## 6. Upstream issue draft (engram) — ready to file

> **Title:** Destructive guard blocks benign bash commands and cannot be disabled for sandboxed consumers
>
> **Context.** A consumer that gates only its merge tool (`gates.json = {"tiers":[{"tool":"merge_pr"}]}`) still has every `bash` call screened by `DEFAULT_DESTRUCTIVE_PATTERNS`, because `evaluateGate()` checks the destructive list before the tier table and returns `"destructive"` for tools with no entry. `GatesConfig.destructivePatterns` is append-only, so there is no supported way to run with bash genuinely ungated — which is the correct posture when execution happens inside a sealed container (`network=none`, single workspace mount).
>
> **Repro** (pin `51b4d39`, policy above): `npm ci >/dev/null 2>&1` → `destructive`; `cd /x && npm test 2>/dev/null` → `destructive`; `grep -rn 'shutdown' src/` → `destructive`; `node -e "console.log('DROP TABLE x')"` → `destructive`. Each blocks with "This action was classified DESTRUCTIVE" and stalls an unattended run until TTL auto-denies.
>
> **Ask 1 — match commands, not substrings.** For `bash`, tokenize (split on `&&`, `||`, `;`, `|`, newline; strip redirections to `/dev/null`) and test each *simple command's* head+args rather than the raw line, so mentioning an action (`grep shutdown`, a heredoc containing `rm -rf`, SQL inside a string literal) is not the same as performing it. Keep matching conservatively for non-bash tools (canonical JSON).
>
> **Ask 2 — make the floor declarable.** Add a config escape hatch, e.g. `"destructive": {"excludePatterns": […]}` and/or a per-tool `{"tool":"bash","containment":"sandbox"}` that skips the floor for that tool, with a loud startup warning + log line so it can never be enabled by accident. Safety argument: an approval prompt in front of a command that runs inside a container with no network and no host mount provides *no* protection the containment does not already provide — it only stops production. Today the choice is "accept false positives" or "fork the guard".
>
> **Notes.** Renaming the tool does not dodge the patterns (non-bash args are matched as canonical JSON). Current docs read `any gated call … / 4. Ungated tools: unchanged`, which suggests D1 may be a drift from intent; `app/test/gates.test.ts:46` asserts otherwise, so treat it as intended and add the opt-out rather than reversing the floor.

## 7. Residual risk (state honestly)

- The stopgap is prompt-level: a model that ignores the hygiene rule still stalls. Detection today is manual (`fleet/supervisor.ts status` reports `awaiting-approval`). **Candidate follow-up:** a gate/alert that fails loudly when an instance holds a pending approval with `tool === "bash"` for more than N minutes — that turns a silent stall into a visible failure regardless of whose fix lands.
- `rm -rf node_modules && npm install` remains blocked; the worker prompt now avoids it, but real repos with lockfile churn may need it (setup runs happen factory-side in `setup-sandbox.ts`, outside tool gating, which is why no run has hit this yet).
- Upstream fix, when it lands, must be re-validated against pin discipline (plan N4): suites A/C of the new test are the tripwire.
