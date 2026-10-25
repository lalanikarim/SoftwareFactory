# Multi-Repo Factory Plan — Target 1 (N factories) spec, Target 2 as follow-up

_Date: 2026-10-25 · Status: proposed — pending sign-off before implementation_
_Companions: [`poc-plan-factory.md`](poc-plan-factory.md) (completed PoC, G0–G5 + Phase 6), [`pi-durable-feasibility.md`](pi-durable-feasibility.md) (feasibility assessment). The single-repo factory this extends is fully built and measured: issue → sandboxed worker → independent review → evidence on the PR → approval-gated exactly-once merge → verified feedback loop, at 129–433s and ~81–145K tokens per bounded issue on one local GPU (plan doc §1g)._

## 1. Goal & non-goals

**Goal.** Manage **multiple repositories simultaneously** with the validated single-repo factory: each repo gets the full loop (webhook intake → worker → review → evidence → human-approved merge), independently supervised, sharing one inference endpoint.

**Non-goals (this phase):** cross-repo orchestration by a single orchestrator (Target 2, §4), HA/failover, Postgres-backed storage, parallel workers *within* a repo, browser/email/MCP. These carry over from the PoC plan's non-goals unchanged.

## 2. The two targets (decision context)

| | **Target 1 — N factories** | **Target 2 — one orchestrator, M repos** |
|---|---|---|
| Shape | One factory process per repo, running simultaneously; shared webhook adapter routes by repo | One factory process whose orchestrator knows all managed repos and can sequence work across them |
| Onboarding a repo | config + image + process + webhook route (~1h) | config entry + webhook secret only |
| Failure isolation | Per-repo: one stuck repo never blocks another | Shared queue: one stuck repo can head-of-line-block the rest (until governed) |
| Cross-repo work | **Human is the coordinator** — files/sequences issues in each repo; factories stay single-minded | Orchestrator sequences cross-repo chains itself; human reviews linked PRs |
| Blast radius of a bad run | One repo's factory | All managed repos' orchestration |
| Human checkpoint | Per-PR approval (unchanged) | Per-PR approval (unchanged — Target 2 automates sequencing, never approval) |

**Decision:** build Target 1 now. It reuses every validated gate with zero core changes, keeps the orchestrator single-repo (the exact condition under which G0–G5 passed on a local 27B), and its artifacts (config files, adapter map, budgets) are the same shapes Target 2 aggregates later. Target 2 is specified as a follow-up (§4) with an explicit decision rule for funding it.

## 3. Target 1 specification

### 3.1 Per-repo config file

*Status: implemented — `poc/lib/factory-config.mjs` + `poc/config/`, with legacy env fallback during transition.*

One validated JSON file per managed repo (factory-side, not in the target repo), e.g. `poc/config/<repo>.json`:

```json
{
  "repo": "owner/name",
  "sandboxImage": "factory-sandbox-node:latest",
  "setupCommand": "npm ci",                  // host-defined; runs in a sealed setup phase, §3.6
  "testCommand": "node --test",              // see open decision D1
  "gitToken": "${FACTORY_GIT_TOKEN_OWNER}",  // per-repo, minimal scopes (§3.5)
  "budgets": { "wallSecsPerIssue": 1800, "maxReviewRetries": 2 },
  "lessonsFile": "data/lessons-owner-name.md"
}
```

- **Validated at factory startup** (schema + fail-fast); env vars remain as overrides for the existing single-repo wiring during transition.
- Host concerns (image, setup, budgets, token) live here; repo *knowledge* (test command) is the candidate for in-repo declaration — open decision D1.
- Stale-config risk is loud, not silent: a wrong `testCommand` fails the host-verified suite and the review gate.

### 3.2 Webhook adapter routing (per-repo secrets)

*Status: implemented — `poc/lib/adapter.mjs` + routes mode in `poc/lib/intake.mjs`; G0 extended to 18/18 with M3 cross-repo rejection checks.*

Extends the signature verification landed in the webhook PR (`poc/lib/intake.mjs`):

- Adapter holds a **`repo full_name → { secret, /tasks target }` map** (from its own config), one entry per managed repo.
- Verification stays **pre-parse**: the raw body is HMAC-checked against each configured secret in constant time; the matching secret identifies both authenticity *and* routing — signature validity doubles as per-repo authorization. An event signed with repo A's secret but naming repo B is rejected (403 + audit line), so a leaked per-repo secret cannot forge submissions into another factory.
- Secrets remain **per-repo, never global** (design decision already recorded in `poc/README.md`); org-level webhooks are deliberately avoided.
- `requestId = "issue-<n>"` stays as-is: each factory has its own durable namespace, so no cross-repo collisions.

### 3.3 Process model & supervision

*Status: implemented — `poc/supervise.mjs` (fleet file, restart-on-fault, status table); examples in `poc/fleet.example.json` / `poc/routes.example.json`.*

- **One factory process per repo** — the existing `lib/factory.mjs` needs no core changes; each instance gets its own port, sqlite db, lessons file, and config from §3.1.
- Supervision via compose/systemd: one unit per factory + one adapter unit; restart-on-fault (the durable harness already recovers in-process state from its db — crash-durability is the PoC's core property).
- **Status aggregation**: a small read-only script/endpoint that fans out to each factory's `/health`, `/approvals`, and `/tool-results` and prints one table: repo, current issue, state (working / awaiting approval / stuck), wall time so far. This is the operator dashboard for Target 1.

### 3.4 Shared-resource governance (the one new design problem)

*Status: implemented — `awaitIdleWithinBudget` in `poc/lib/factory-worker.mjs`, enforced in both worker and reviewer wait phases from `budgets.wallSecsPerIssue`; live-verified with a 5s budget (clean abort, partial branch preserved, no PR opened).*

All factories share one inference endpoint (Aurora/llama-server on the RTX 4090). Today there is no queueing or budgeting anywhere; a trap issue on repo A (issue #4 showed ~30 min of dead-ends in dev runs) would silently starve B and C.

- **Per-issue wall-clock budget** (`budgets.wallSecsPerIssue`): enforced host-side in the worker's and reviewer's wait phases — on overrun the conversation is aborted cleanly (`ConversationHandle.abort`), the sandbox is torn down, the partial branch stays on disk for the stale-branch rework path, and the overrun is recorded in the task outcome (surfaced to the orchestrator as a `delegate` error) plus an audit log line. This bounds worst-case starvation per issue.
- **Per-factory concurrency stays 1** (already true: one root conversation processes submissions sequentially). With N factories, total concurrent GPU demand is bounded by N; admission control beyond that is out of scope for the pilot.
- **Honest limit:** budgets cap the damage; they are not fair-share scheduling. If measured contention becomes a problem (Phase 6 instrumentation already extracts per-run tokens/wall time — extend `07-measurement.mjs` to aggregate across factories), revisit with a real queue.

### 3.5 Credential scoping

- Per-repo GitHub tokens in the config (§3.1), minimal scopes (`repo` for the managed repo only; no org-wide token).
- One leaked token compromises one repo's factory, matching the webhook-secret blast-radius decision (§3.2).

### 3.6 Sandbox images & dependency install

*Status: implemented — `poc/lib/setup-sandbox.mjs`, wired into both worker and reviewer spawn phases.*

Default strategy: **ephemeral setup phase** — a one-shot disposable container runs the host-defined `setupCommand` (e.g. `npm ci`) with egress, then exits; the long-lived agent sandbox is created sealed (`network=none`). Dependency state persists via the host-mounted workspace volume, so the agent never runs in a networked container and the setup command comes from factory-side config, never repo content. Runs are idempotent (re-run on task resume) and fail closed before the agent conversation starts. Optimization (later): per-repo prebuilt images with deps baked in.

### 3.7 Gates & acceptance criteria

| Gate | Check |
|---|---|
| **M1 — two repos live** | Two real repos onboarded; each completes label → draft PR (evidence complete) → approve → merge exactly once, on the same machine simultaneously |
| **M2 — isolation** | Factory A SIGKILLed or budget-stuck mid-run while factory B completes an issue end-to-end unaffected |
| **M3 — cross-repo signature rejection** | Event signed with repo A's secret naming repo B → 403, not routed; valid per-repo events route correctly |
| **M4 — budget enforcement** | A long-running issue hits `wallSecsPerIssue`, is aborted cleanly (partial branch preserved), and the other repo's runs are unaffected |

### 3.8 Effort & risks

| Work | Estimate |
|---|---|
| Adapter routing map + M3 checks | 0.5d |
| Per-repo config loading + validation | 0.5d |
| Setup-phase sandbox (ephemeral network) | 1d |
| Supervision + status aggregation | 0.5d |
| Budgets + M4 enforcement | 0.5–1d |
| Two pilot repos end-to-end (M1, M2) incl. tuning | 1–1.5d |

**Total: ~3–5 focused days.** Risks: (1) per-repo image/setup differences surface only at M1 — mitigated by picking two similar-stack pilot repos first; (2) GPU contention worse than budgets assume — measured, not predicted, via the extended metrics script; (3) supervision gaps (zombie sandboxes after hard kills) — the existing per-conversation sandbox teardown already handles in-process faults; host-level kill cleanup is a known small gap to verify in M2.

## 4. Target 2 as follow-up (one orchestrator, M repos)

### 4.1 What carries over from Target 1

Worker/reviewer roles (repo-parameterized), merge gate + single-use approvals (stable keys already hash tool+args — adding `repo` namespaces them), config files (become one registry of the same shape), adapter map (simplifies: `repo → secret`, one target), sandbox images, budgets, and all G0–G5 per-role evidence. **Target 1 is a strict subset; nothing built for it is wasted if Target 2 fails.**

### 4.2 The delta

| Work | Estimate | Type |
|---|---|---|
| Repo-parameterized tools (`delegate({repo,…})` etc.), workspaces re-keyed `work/<repo>/issue-<n>`, requestIds `repo-issue-n` | 1–2d | Plumbing, low risk |
| Shared-queue governance inside one process (Target 1 got isolation free from processes) | 1–2d | Design + plumbing |
| Cross-repo planning: approval-gated `file_issue` host tool, durable `cross-repo-plan` doc family tracking A→B chains, repo-aware orchestrator instructions, iteration until reliable | 3–5d | **Model capability — the open question** |
| Second fixture repo + G6 battery (cross-repo issue → correctly sequenced linked PRs → both merged exactly once) | 1d | Plumbing |
| Docs + gate write-up | 0.5d | Writing |

**Total: ~7–11 focused days; realistically 2–3 calendar weeks** — the long pole is iterating until the local 27B sequences reliably (the PoC's own experience: the model skips optional steps; cross-repo sequencing needs structural enforcement — durable plan doc + gate checks — not prompt trust).

### 4.3 The hybrid (de-risking option)

One process, but **one root conversation per repo plus a dedicated coordinator conversation** for cross-repo work (pi-durable supports multiple owner-linked conversations per harness; the PoC has always used one). This keeps Target 1's failure isolation *inside* a single deployment and confines cross-repo intelligence to one role — which is exactly the role Phase 6's sizing conclusion flagged for cloud offload first. Estimated at **~60% of the §4.2 delta for ~80% of Target 2's value**.

### 4.4 Decision rule (when to fund Target 2)

Run the Target 1 pilot and **count Journey D**: how often does a human have to manually sequence work across repos (issues filed in repo B because repo A's change needs it)?

- **Rare (≲ once/week):** stay on Target 1; the human-as-coordinator cost is two extra issue filings.
- **Frequent:** fund the **hybrid first** (§4.3), pointing the coordinator role at a cloud frontier model if local-model sequencing proves unreliable under G6; full single-orchestrator Target 2 only after the coordinator role passes its gate.

### 4.5 Open decisions (to close before implementation)

| # | Decision | Default in this spec |
|---|---|---|
| D1 | Test command: factory-side config (B) vs repo-declared `factory.yaml` (C) — C is only safe if **all** test execution moves into sandboxes (incl. the host-side PR verification, which today runs on the host) | **Resolved 2026-10-25: B adopted and implemented** (`poc/lib/factory-config.mjs`, argv-only command validation). Revisit C with sandboxed host-verification after M1 |
| D2 | Per-repo token provisioning (who issues/rotates) | Operator-managed in config; secret manager integration later |
| D3 | Pilot repo pair (prefer similar stacks to de-risk images) | TBD at implementation start |
| D4 | Second fixture repo for G6 | Only if Target 2 is funded per §4.4 |
