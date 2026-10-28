# Multi-Repo Factory Plan — Target 1 (N factories) spec, Target 2 as follow-up

_Date: 2026-10-26 · Status: signed off — Phase 0 done (PR #31), Phase 1 in flight (`feature/phase1-factory-core`)_
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

*Status: implemented — `poc/lib/adapter.mjs` + routes mode in `poc/lib/intake.mjs`; G0 extended to 20/20 (M3 cross-repo rejection + sender allowlist).*

Extends the signature verification landed in the webhook PR (`poc/lib/intake.mjs`):

- Adapter holds a **`repo full_name → { secret, /tasks target }` map** (from its own config), one entry per managed repo.
- Verification stays **pre-parse**: the raw body is HMAC-checked against each configured secret in constant time; the matching secret identifies both authenticity *and* routing — signature validity doubles as per-repo authorization. An event signed with repo A's secret but naming repo B is rejected (403 + audit line), so a leaked per-repo secret cannot forge submissions into another factory.
- Secrets remain **per-repo, never global** (design decision already recorded in `poc/README.md`); org-level webhooks are deliberately avoided.
- **Sender allowlist:** signature validity proves GitHub sent the event, not who acted. Each route may declare `allowedSenders: [logins]`; non-matching `sender.login` is rejected 403 + audit line (checked post-signature, so the field is trusted). This gates both issue creation and label triage.
- `requestId = "issue-<n>"` stays as-is: each factory has its own durable namespace, so no cross-repo collisions.

### 3.3 Process model & supervision

*Status: implemented — `poc/supervise.mjs` (fleet file, restart-on-fault, status table); examples in `poc/fleet.example.json` / `poc/routes.example.json`; approval TTL auto-deny in `poc/lib/merge-gate.mjs` (2026-10-26).*

- **One factory process per repo** — the existing `lib/factory.mjs` needs no core changes; each instance gets its own port, sqlite db, lessons file, and config from §3.1.
- Supervision via compose/systemd: one unit per factory + one adapter unit; restart-on-fault (the durable harness already recovers in-process state from its db — crash-durability is the PoC's core property).
- **Status aggregation**: a small read-only script/endpoint that fans out to each factory's `/health`, `/approvals`, and `/tool-results` and prints one table: repo, current issue, state (working / awaiting approval / stuck), wall time so far. This is the operator dashboard for Target 1.
- **Approval expiry (TTL auto-deny)**: a pending merge approval no longer blocks a factory's single concurrency slot forever. `GET /approvals` resolves pending records against `approvalTtlHours` (per-repo config, §3.1; default **24 h**): expired records are durably auto-denied with `decidedBy: "ttl"` (idempotent, re-checked under concurrent decisions), and the `merge_pr` retry path reports EXPIRED so the orchestrator knows a fresh human approval is needed rather than looping. Records created before the field existed get their clock stamped on first observation. Pattern from engram approvals phase 3; decision logic unit-tested in `test/merge-gate-ttl.test.mjs`.

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

*Status: implemented — `poc/lib/setup-sandbox.mjs`, wired into both worker and reviewer spawn phases; image/mount-root allowlist in `poc/lib/sandbox-health.mjs` (2026-10-26).*

Default strategy: **ephemeral setup phase** — a one-shot disposable container runs the host-defined `setupCommand` (e.g. `npm ci`) with egress, then exits; the long-lived agent sandbox is created sealed (`network=none`). Dependency state persists via the host-mounted workspace volume, so the agent never runs in a networked container and the setup command comes from factory-side config, never repo content. Runs are idempotent (re-run on task resume) and fail closed before the agent conversation starts. Optimization (later): per-repo prebuilt images with deps baked in.

**Containment last line — sandbox allowlist** (pattern from engram phase 7): every container the factory spawns (setup, worker, reviewer — including supervised recreation) is validated against a **factory-level policy** before any podman call: the base image must be on `SANDBOX_ALLOW_IMAGES` (comma-separated env; default `factory-sandbox:latest`) and the workspace must live under `SANDBOX_MOUNT_ROOT` (default: the factory's work dir). The policy is deliberately **not** per-repo config — a repo entry may select from the allowlist but can never widen it, so a stale or compromised `<repo>.json` fails fast with a clear message instead of spawning an arbitrary container. Unit-tested in `test/sandbox-allowlist.test.mjs` (incl. mount-root prefix-trickery).

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

### 3.9 Open recovery tasks (surfaced by the drydock self-run)

- **T1 — Recover from partial runs:** when a task aborts mid-work (e.g., wall-clock budget exceeded) after changes have been made, preserve the partial work and resume/requeue rather than treating the run as a clean failure. Currently the abort lands in a terminal task state and the orchestrator concludes; there is no recover-from-partial path. Surfaced by the drydock self-run (issue #18 → aborted at the 1800s budget; fix + regression test written but uncommitted; no PR opened).

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

## 5. Migration to engram core (drop poc wiring for a proper composition)

_Date: 2026-10-26 · Status: Phase 0 complete — Phase 1 pending start. Full issue: [#30](https://github.com/lalanikarim/drydock/issues/30)._

**Decision (owner, 2026-10-26):** drydock is built **on an engram core**, not the other way around. The explicit poc-era wiring — hand-rolled registry composition, raw http shim, own approval plumbing, imports of `vendor/engram/poc/lib/*` helpers — is dropped in favor of a proper composition against the core's public seam `createCoreInstance()` (engram issue #42 / PR #43). **Boundary: engram provides the core; all factory business logic stays in drydock.** Nothing factory-specific moves upstream.

### 5.1 The seam (pin target `cde8bb7`)

`createCoreInstance({ config, modelsConfig?, extraExtensions?, host?, port?, rootAgent?, rootInit? }) → { harness, server, actualPort, rootConversationId, close }`, plus `loadConfig(overrides?)`. Stability contract (engram `src/core.ts`): lifecycle + injection point stable; config additive; breaking seam changes get a major bump. **Import rule for factory code: only `vendor/engram/app/src/core.ts` and `config.ts`** — nothing from `app/src/` internals or `poc/lib`. Reference doc: engram `docs/ecosystem-flows.md`, Flow 4 (this migration) — supersedes the flow sections of `product-core-split.md`, which remains the seam API record (PR #43).

### 5.2 Dropped vs. kept

| Dropped (replaced by core wiring) | Kept in drydock (business logic, ported to TS extensions) |
|---|---|
| `MergeApprovalDoc` + JSON `/approvals` endpoint (+ §3.3 TTL port, PR #28) → core approval machinery: tiers, destructive guard, allow-rules, TTL, batching, Telegram/Web surfaces | Webhook intake: HMAC pre-parse verification, per-repo routing, sender allowlist (`intake.mjs`, `adapter.mjs`) — routes retarget core `/tasks` |
| Raw node-http shim in `factory.mjs` (`/tasks`, `/health`, …) → core HTTP/SSE server + Web UI + Telegram | Worker/reviewer task defs, prompts, tool filtering |
| Hand-rolled sandbox allowlist (PR #29) → core `SandboxManager` allowlists | Merge gate git semantics: `gh` ops, draft→ready, verified PR-state idempotency (merge = destructive-tier gated tool) |
| Imports of `vendor/engram/poc/lib/{model,env,podman-sandbox}.mjs` → `loadModelsConfig` / `loadConfig(overrides)` / core per-conversation env | Wall-clock budgets (`awaitIdleWithinBudget`) |
| `supervise.mjs` `/approvals` fan-out for stuck detection → `GET /board` + client surfaces (thin fleet aggregator may remain) | Lessons feedback loop; supervised sandbox health wrapper over `SandboxManager`; per-repo config validation → per-instance `loadConfig(overrides)` + factory budgets |

### 5.3 Decisions (locked 2026-10-26)

| # | Decision | Resolution |
|---|---|---|
| D2 | Merge approval consumption | **Drop single-use consumption.** Keys are per-args and the tool is idempotent via verified PR state (stays in drydock); exactly-once rests on GitHub state. Behavior delta: an approved-but-never-executed merge auto-passes if the identical call recurs — matches core semantics for all tools |
| D3 | Repo layout | **New tree:** `vendor/engram/` + `factory/` (main, intake, worker, reviewer, merge-gate, budgets, lessons, config) + `fleet/`; `poc/` decommissioned after cutover. Gate letters (G0–G5, M1–M3) remain the acceptance vocabulary |
| D4 | Composition language | **TS** (matches core; shares types with `core.ts`/`config.ts`; type-stripping runtime verified in Phase 0) |

### 5.4 Phases

- **Phase 0 — Spike: DONE (PR #31, merged 2026-10-26).** Pin bumped to `cde8bb7`; `poc/core-spike.test.ts` passes 8/8: single pi-durable copy across the vendor boundary (the vendored copy resolves bare imports into drydock's `poc/node_modules` — no dual-package hazard; standing rule: never install node_modules inside the submodule), drydock-defined `extraExtensions` visible to root, core tools coexist, board does not leak into the bare core, `/health` on ephemeral port, idempotent `close()` + port release. Pre-existing suite 30/30 unaffected.
- **Phase 1 — Port the pipeline as extensions: DONE (branch `feature/phase1-factory-core`, 2026-10-26).** New `factory/` TS tree on the root package layout (submodule at `vendor/engram`, single `node_modules`): `main.ts` (per-repo instance via `createCoreInstance({ extraExtensions: [factoryPipeline], port: 0, rootAgent })`), `pipeline.ts` (the `factory` extension: worker/reviewer tasks + `delegate`/`open_draft_pr`/`merge_pr`/`note_lesson` + reviewer role tools), `worker.ts`/`reviewer.ts` (durable task defs; sandboxed via core `ConversationMeta.sandbox` + `cwd`, container lifecycle owned by the core's `SandboxManager`), `open-draft-pr.ts` (structural review gate before push, idempotent draft PR), `merge-gate.ts` (D2: destructive-tier approval via instance `gates.json`, exactly-once via verified PR state — no consumption doc), `intake.ts`/`adapter.ts` (HMAC + sender allowlist unchanged; routes gain a per-instance `token` for the core's Bearer-auth `/tasks`), `budgets.ts`, `lessons.ts`, `setup-sandbox.ts`, `factory-config.ts` (per-repo config now carries an explicit `models` ref). Evidence: `factory/pipeline.test.ts` (extension shape) + `factory/intake.test.ts` (signature/cross-repo/allowlist, gate M3) pass; `factory/pipeline-boot.test.ts` boots the full pipeline on the core — `/health`, root conversation listed, `/tasks` accepted a submission against the factory root agent, idempotent close + port release; `main.ts` smoke: factory-fixture instance boots, `/health` 200 with generated Bearer token, graceful SIGTERM. **Known pending:** dead-container supervision (#20) is not yet reachable from the seam — engram issue #44 requests `ConversationMeta`/`SandboxManager` on the core export; until then a dead container surfaces as an exec error (matches current engram product behavior). Sandbox-flag doc is imported from `app/src/meta.ts` TEMP pending #44.
- **Phase 2 — Parity: DONE (PR #34, merged 2026-10-27).** Gate suite retargeted to exercise the PRODUCTION entrypoint (`factory/main.ts` as a supervised child process via `gates/lib.ts`; nothing re-implements composition): G0–G5 + M1/M2/M4 scripts + measurement all rewritten; M3 is covered inside G0. **Pin bumped to `51b4d39`** (engram #48 fix: `overrides.configDir` honored for per-instance `gates.json`; also brings the additive app-route seam, PR #46). Two live-run defects found and fixed during G1 re-runs (commit `9160d64`): (a) our instance `gates.json` had a destructivePattern matching `{"issueNumber":N}` — identical arg shape to `delegate()`, so every delegate call was classified destructive and unattended runs stalled; pattern removed (merge_pr stays prompt-tiered via tiers, D2 unchanged). (b) worker wrote its own e2e script that hung ~15 min in the sealed sidecar (bash tool has no default exec timeout; only the wall-clock budget catches it) — worker prompt now forbids self-written long-running scripts. **Results so far:** G0 PASS 20/20; G1 PASS — unattended label→draft PR #15 for issue #3 in **597 s** (baseline ceiling 433 s; drift to be explained with the full battery + Phase 6 metrics). **G2 first run (superseded):** #16 PASS; #17/#18 FAIL — root cause was NOT the factory: fixture issues #16–#19 were mis-seeded on GitHub (all four carried issue #16's customer-filter title/body, a variable-reuse bug in the seeding command), so workers faithfully implemented #16's spec three times; verified via the worker conversation entries in the instance sqlite (prompt for "issue #17" contained #16's body) and `gh api` on the live issues. Fixtures corrected 2026-10-27: #17 = summary openCents/paidCents breakdown, #18 = idempotent no-op status transitions (paid→voided stays 409), #19 = unknown-status PUT returns 4xx not 500; stale draft PRs #21/#22/#23 closed and branches deleted. **G2 re-run: PASS 3/3** — #16 PR #25 (309 s), #17 PR #26 (228 s), #18 PR #27 (195 s); suite/scope/behavior/zeroEdits all ok per issue. **G3: PASS** — T1 negative on seeded-bad branch: verdict=fail with reason naming the root cause (non-2xx treated as success → status never surfaced → retries never fire); T2 positive on known-good #1: verdict=pass. Two gate-script defects fixed in `gates/g3-reviewer.mjs`: (a) TS-only syntax + wrong `node:fs/promises` import crashed load; (b) the local `review` tool was passed only via `rootAgent.tools`, but agent tool filters resolve by name against the registry — unregistered definitions are silently dropped, so the root agent saw no tools; fixed by registering it in the gate's extension. **G4: PASS** — T1 happy path (approve → merge `7c3e776`, exactly-one-merge verified, durable decision recorded; 19 s) and T2 crash (SIGKILL while approval pending → restart over the same store → **approval state survived the restart** → approve → merge `0d2a5d5`, exactly-one-merge verified; 18 s). Merge mode targets existing draft PRs (#25/#26 for issues #16/#17) and makes no inference calls. **G5: PASS (321 s), attribution=strong** — trap issue #19 (unknown status on PUT → 4xx, not 500). Step A (no lesson): worker applied the handler-level anti-pattern (catch `TypeError` in the route and rethrow with `statusCode: 400`) — exactly the concern raised on PR #12; orchestrator recorded a standing lesson. Step B (lesson fed to the worker prompt): root-cause fix instead — new `UnknownStatusError` error class with `statusCode = 400` thrown from the store; the handler patch did not recur. The feedback loop demonstrably changed behavior, not just prose. **Measurement vs baseline (post-migration, 2026-10-27):** wall time per bounded issue — #16: 293/304 s, #17: 211/212 s, #18: 170/179 s, #19 (G5 steps A/B): 109/204 s; **all inside the pre-migration 129–433 s band** on the same single-GPU endpoint (aurora, Qwen3.8-27B GGUF). Tokens per issue (total incl. cache reads): 119K–220K vs baseline ~81–145K — higher, driven by cache-read-dominated context re-sends on the worker conversation (worker totals 76K–183K); non-cached in+out is ~24K–56K per issue. G1's 597 s remains the outlier vs the band and stays open for explanation (single unattended run, includes label→intake latency). M1/M2/M4 need a second onboarded repo — they run with Phase 3 cutover (scripts ready; env-parameterized). **Honesty note: prior G0–G5 evidence is superseded by this rewire until Phase 2 passes.**
- **Phase 3 — Cutover & decommission: DONE (branch `feature/phase3-cutover`, 2026-10-28).** Second pilot repo is a purpose-built fixture (`lalanikarim/factory-fixture-2`: dependency-free Node job-queue service, `node --test`; config `factory/config/lalanikarim_factory-fixture-2.json`) rather than drydock itself — dogfooding drydock stays a post-cutover goal. **Fleet supervisor ported to TS** (`fleet/supervisor.ts`): one `factory/main.ts` child per repo + optional webhook adapter, restart-on-fault with backoff (max 10), ephemeral ports learned from each child's ready line, supervisor-owned routes file (all repos listed at boot so the adapter validates before instances are ready; `target` filled on ready, removed on exit; per-repo webhook secret required in the fleet file — env override `GITHUB_WEBHOOK_SECRET_<owner>_<repo>`); `status` subcommand reports up/awaiting-approval per repo via authenticated `/health` + `/approvals`. Smoke: adapter listening with 2 routes, both factories up, status shows both, SIGTERM shuts everything down cleanly. **M-gates (live, both repos):** M1 PASS — fixture#30 (`?limit=` pagination) ∥ fixture-2#10 (tags array), each full chain label→worker→review→draft PR→approve→merge with evidence + exactly-one-merge verified; 182 s / 180 s. M2 PASS — A SIGKILLed mid-run (6 s in, worker just spawned), B (#2 priority validation) completed unaffected: PR #14 merged, single-merge verified. M4 PASS — A aborted by a 30 s `wallSecsPerIssue` budget (`wall-clock budget exceeded`, durable abort outcome, no PR; partial branch discarded later), B (#16 ageSeconds) completed: PR merged, exactly-once; 112 s. **M4 lesson:** the first attempt set a 120 s budget on a task the worker finished in ~86 s — nothing to abort, gate waited on a pattern that never came (test-design miss, not a product defect; budgets fire when the budget is below task duration). **Gate-helper bug found via M2:** `gates/lib.ts rootConversationId()` assumed `/conversations` returns oldest-first — it returns newest-first, so with worker/reviewer conversations present the gate polled the reviewer's conversation and wedged until timeout; fixed to select `isRoot`. **Decommission:** `poc/` deleted in full (JS gates/lib/factory tree, runtime state, 828 MB); sandbox Dockerfile moved to `factory/sandbox-image/`; `.env` + `.env.example` moved to repo root (all loaders updated); poc-era unit tests retargeted (`sandbox-allowlist` → `factory/setup-sandbox.ts`; TTL test keeps only the config field — decision logic lives in core; `sandbox-health` deleted, container supervision is core-owned pending #44). Unit suite green post-deletion. **Open posture note:** with the core's built-in approvals extension active, some compound worker bash commands (e.g. `ls /sandbox && cat README`) are classified DESTRUCTIVE and block until approved, despite our `gates.json` gating only `merge_pr` — observed twice, workers recovered by rephrasing; needs investigation (core default rule matching vs factory gate policy) before fully unattended fleets. **Update (2026-10-28): root-caused and stopgapped** — see [`n1-bash-destructive-misclassification.md`](n1-bash-destructive-misclassification.md) (two core defects: destructive floor applies to ungated tools, substring-not-shell-aware matching); worker prompt now avoids the triggering shapes and a characterization test pins the behavior. Upstream fix still pending.
- **Phase 4 — Pin discipline (ongoing).** One gate script runs the full suite; every submodule bump re-validated against the stability contract.

### 5.5 Effort & risks

~1–2 focused weeks for Phases 1–3. Risks: upstream churn (mitigated by SHA pin + gate script + stability contract); evidence reset at Phase 2 (stated explicitly, baseline recorded); `extraExtensions` run with full core privilege (vet like first-party code; consequential actions registered as approval-gated tools — the "human is the control boundary" invariant must survive into consumer extensions); per-instance human surfaces grow attack surface (bearer token + LAN bind posture; destructive tier keeps merges human-gated).

### 5.6 Follow-on effects

- **§3.9 T1 (partial-run recovery) stays parked** until after migration — the resume/requeue design is cleaner on the core's task machinery.
- **Target 2 (§4) becomes the board/collective story:** engram's Project 0 board + Collective A1–A4 (member domain memory, peer trust tiers, untrusted peer input, containment of a bad member) are built and tested upstream; per-repo instances become members via the M2 federation seam. Revisit the §4.4 decision rule after Phase 3.
- PRs #28 (approval TTL) and #29 (sandbox allowlist) are **absorbed by the core** once Phases 1–3 land — they were manual ports of exactly the machinery the composition now provides; their tests move with the code or are retired at cutover.

### 5.7 Post-cutover roadmap (agreed 2026-10-28, after PR #35)

Migration Phases 0–3 are DONE and merged (`main` = `acbfdb5`). Remaining work, in priority order:

| # | Item | Why it matters | Status |
|---|---|---|---|
| N1 | **Bash DESTRUCTIVE misclassification** — repro the compound-command blocks against pin `51b4d39`, root-cause (core built-in approvals default rules vs factory `gates.json` tier policy), fix factory-side or file upstream | Only known blocker to fully unattended fleets (observed twice in M2/M4; workers self-recovered by rephrasing) | **Root-caused + stopgap shipped** (2026-10-28, [`n1-bash-destructive-misclassification.md`](n1-bash-destructive-misclassification.md)): two core defects — the built-in destructive floor is evaluated before the tier table so it gates tools with NO tier entry (and `destructivePatterns` is append-only: no opt-out), and matching is unanchored substring regex over the raw command line (`>/dev/null`, `grep -rn shutdown src/`, SQL in a string all match). Factory-side stopgap: worker prompt shell-hygiene rule + `test/n1-destructive-classification.test.mjs` (safety-floor guard / false-positive TODOs / pin characterization / hygiene test, wired into `npm test`). Upstream issue **filed**: [engram#53](https://github.com/lalanikarim/engram/issues/53) (Ask 1 shell-aware matching, Ask 2 declarable floor); the real fix stays upstream |
| N1a | **Stall detection for pending bash approvals** — fail loud when an instance holds a pending approval with `tool === "bash"` beyond N minutes (supervisor `status` already reports awaiting-approval) | Until the core guard is fixed, a false positive is a *silent* stall; this makes it a visible failure | Open (new, from N1) |
| N2 | **Full-battery confirmation run + Phase 6 metrics** — G0–G5 + M1/M2/M4 back-to-back on the final tree; consolidated wall/token table | Closes the two open honesty items: G1's 597 s drift vs the 433 s ceiling, and replacing piecemeal per-gate numbers with one post-migration table | Open |
| N3 | **Drydock dogfooding** — onboard drydock as a managed repo under its own factory: per-repo config (`setupCommand`, submodule-aware clone), branch protection on `main`, real webhook secret + GitHub webhook, first self-assigned issue end-to-end | Original goal of the whole exercise; also the moment the **live webhook path** gets real (adapter is built + unit-tested, but every gate so far posts `/tasks` directly — no live GitHub signature has ever been verified) | Open |
| N4 | **Pin discipline script** (Phase 4) — single `gates/all.mjs` runner re-validating the suite per submodule bump | Makes the SHA-pin stability contract mechanical instead of ritual | Open |
| N5 | **engram #44 watch** — `ConversationMeta`/`SandboxManager` on the core seam; then remove the TEMP import in `factory/worker.ts` and revisit dead-container supervision (#20) | Last known boundary gap to vendored internals | Blocked upstream |
| N6 | **T1 partial-run recovery (§3.9)** — resume/requeue design on the core's task machinery | Parked until post-migration; migration is now done | Unblocked, not started |
