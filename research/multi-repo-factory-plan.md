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
| N1 | **Bash DESTRUCTIVE misclassification** — repro the compound-command blocks against pin `51b4d39`, root-cause (core built-in approvals default rules vs factory `gates.json` tier policy), fix factory-side or file upstream | Only known blocker to fully unattended fleets (observed twice in M2/M4; workers self-recovered by rephrasing) | **Closed for factory scope** — merged to `main` via PR #37 (`15b2248`, 2026-10-28); upstream fix still pending [engram#53](https://github.com/lalanikarim/engram/issues/53). Root cause (2026-10-28, [`n1-bash-destructive-misclassification.md`](n1-bash-destructive-misclassification.md)): two core defects — the built-in destructive floor is evaluated before the tier table so it gates tools with NO tier entry (and `destructivePatterns` is append-only: no opt-out), and matching is unanchored substring regex over the raw command line (`>/dev/null`, `grep -rn shutdown src/`, SQL in a string all match). Factory-side stopgap: worker prompt shell-hygiene rule + `test/n1-destructive-classification.test.mjs` (safety-floor guard / false-positive TODOs / pin characterization / hygiene test, wired into `npm test`). Upstream issue **filed**: [engram#53](https://github.com/lalanikarim/engram/issues/53) (Ask 1 shell-aware matching, Ask 2 declarable floor) — **FIXED UPSTREAM**: [engram#53](https://github.com/lalanikarim/engram/issues/53) closed by PR #57 in kernel **v0.2.0**; this branch bumps the pin to it and flips suite B from TODOs to real assertions (see §5.8) |
| N1a | **Stall detection for pending bash approvals** — fail loud when an instance holds a pending approval with `tool === "bash"` beyond N minutes (supervisor `status` already reports awaiting-approval) | Until the core guard is fixed, a false positive is a *silent* stall; this makes it a visible failure | Deprioritized (2026-10-28): kernel v0.2.0 removes the false-positive stall this was defending against. Re-scope to generic pending-approval-age alerting as fleet observability, or drop |
| N2 | **Full-battery confirmation run + Phase 6 metrics** — G0–G5 + M1/M2/M4 back-to-back on the final tree; consolidated wall/token table | Closes the two open honesty items: G1's 597 s drift vs the 433 s ceiling, and replacing piecemeal per-gate numbers with one post-migration table | **Done** (2026-10-28) — all nine gates pass on `main` = `2596e9e`; results, six harness defects found while running it, and the remaining token-accounting gap are in §5.9 |
| N3 | **Drydock dogfooding** — onboard drydock as a managed repo under its own factory: per-repo config (`setupCommand`, submodule-aware clone), branch protection on `main`, real webhook secret + GitHub webhook, first self-assigned issue end-to-end | Original goal of the whole exercise; also the moment the **live webhook path** gets real (adapter is built + unit-tested, but every gate so far posts `/tasks` directly — no live GitHub signature has ever been verified) | Open — **scope corrected 2026-10-28**: the adapter and supervisor are already built and unit-tested (§5.11); what is left is deployment (fleet file, webhook secret, token scope); the enforcement side — registry-checked supervisor startup and `autoMerge:false` removing `merge_pr` — is done (§5.11) |
| N4 | **Pin discipline script** (Phase 4) — single `gates/all.mjs` runner re-validating the suite per submodule bump | Makes the SHA-pin stability contract mechanical instead of ritual | Open |
| N5 | **engram #44 watch** — `ConversationMeta`/`SandboxManager` on the core seam; then remove the TEMP import in `factory/worker.ts` and revisit dead-container supervision (#20) | Last known boundary gap to vendored internals | **Unblocked** — engram #44 closed in kernel v0.2.0 (`CoreInstance.sandbox` = `lookup`/`disposeAll`/`sweepOrphans`); the TEMP `ConversationMeta` imports are gone (now via the declared seam) and dead-container supervision (#20) is ours to build |
| N6 | **T1 partial-run recovery (§3.9)** — resume/requeue design on the core's task machinery | Parked until post-migration; migration is now done | Unblocked, not started |
| N7 | **Board/Collective story after the kernel split** — decide whether Target 2 (§4) depends on [lalanikarim/collective](https://github.com/lalanikarim/collective) as a *second* upstream (its own pin/seam) or is retired; §4 and §5.6 currently assume capability the kernel deliberately no longer ships | The split (kernel v0.1.0, PR #55) moved board.ts + all six board suites out of engram; our roadmap text now contradicts upstream reality | Open — written up in [#42](https://github.com/lalanikarim/drydock/issues/42) (client-only federation; no collective dependency; gated on N3) |
| N8 | **Upstream review: two narrowings in the v0.2.0 guard** — quoted payloads through non-shell interpreter heads (`python3 -c "…os.system('rm -rf …')"`, `node -e "…rmSync…"`) classify as data; and the redirection drop is broad enough that `echo x > /dev/sda` classifies as data (the pre-v0.2.0 pattern guarded it). Suggest: extend the live-code head table, narrow the drop to `/dev/null|/dev/stdout|/dev/stderr|/dev/fd/*` | Not our exposure (worker bash runs in the sealed sidecar) but it weakens the floor for uncontained consumers of the kernel we vendored | Open — written up in [#41](https://github.com/lalanikarim/drydock/issues/41) with a ready-to-paste upstream note; still needs filing on engram |

### 5.8 Kernel v0.2.0 (engram): what changed for us (audited 2026-10-28)

`v0.1.0` (board-free split) and `v0.2.0` (`a764e36`, PR #57) landed the same day our Phase 3 cutover merged. Audited by diffing every seam we consume **and** by running the tag's/main's actual gate code in a scratch dir against our own policy — conclusions measured, not inferred.

- **v0.1.0 — repo split.** engram is now kernel + solo executable; the board and its suites moved to `lalanikarim/collective`, which consumes the kernel as `"engram": "github:lalanikarim/engram#<tag>"` with `app/dist/` built by `prepare`. Deep `app/src/*.ts` imports still work but are internals, not the blessed path (board.ts deletion is the empirical argument). A declared public seam was added at `app/src/core.ts` (`loadConfig`, `ConversationMeta`, model helpers, `AppRoute`/`readJsonBody`, approval machinery, `compileGates`).
- **v0.2.0 — N1 fixed (#53) both halves.** (1) *Command matching*: bash lines are reduced to simple-command candidates first — quote-aware split on `&&`/`||`/`|`/`;`/`&`/newline, `/dev/*` redirections dropped, quoted spans masked unless the head is a shell interpreter or `eval`, `reboot`/`shutdown` demoted to head-position commands. (2) *Declarable floor*: a tier may declare `"containment": "sandbox"`, and when `ConversationMeta.sandbox === true` the tool is ungated for that conversation — loud at startup, once-per-conversation log, **uncontained conversations keep the absolute floor**. Free-form pattern exclusion was deliberately rejected (agreed: tokenization removed its justification).
- **Measured before/after with our own policy `{tiers:[{tool:"merge_pr"}]}`:** `npm ci >/dev/null 2>&1`, `cd /sandbox && npm test 2>/dev/null`, `grep -rn 'shutdown' src/`, SQL inside a string literal, and the printf/heredoc case all went **destructive → ungated**; `rm -rf /var`, `mkfs`, `dd if=`, `git push --force`, `git reset --hard`, fork bombs, chains (`ls && rm -rf /data`), `sudo`/`VAR=` prefixes, `xargs`, `sh -c "…"`, `$(…)` and backticks all stay **destructive**. Only `rm -rf node_modules && npm install` still blocks — correctly, it is an `rm -rf`; workers avoid it by policy.
- **v0.2.0 — #44 closed.** `CoreInstance.sandbox: SandboxSupervision { lookup, disposeAll, sweepOrphans }` — exactly the surface needed for dead-container supervision and post-crash orphan sweeping (closes our last known boundary gap to vendored internals).
- **Classifier (approvals phase 5) is inert for us**: it only scores `prompt`-tier actions and `compileClassifier(undefined)` → `{enabled:false}`; our factory-written `gates.json` sets no classifier key. If ever enabled, the extra model call would land on `merge_pr` approvals. Invariants are real code (fail-safe, escalation-only, approval key unchanged so crash-retry idempotency survives).
- **Pin bump verification on this branch (`chore/engram-v020-pin`):** unit suite green (16 N1 checks incl. new containment-semantics and known-narrowing suites), `npm run test:boot` green (8 checks: `/health`, root conversation, `/api/tasks`, idempotent close), **G0 PASS 20/20**. Boot works without `preact`/`htm` installed — those are static Web-UI assets served from `node_modules`, not imports; the per-instance Web UI would need them if we ever surface it. Live gates that mutate fixtures (G1 creates a draft PR, G4 merges) were **not** run here — they need a free fixture issue/PR and explicit sign-off.
- **Open policy question:** adopt `{"tool":"bash","containment":"sandbox"}` in the factory-written `gates.json`? Safe here — only sandboxed conversations ever get bash (orchestrator tools are `delegate`/`open_draft_pr`/`merge_pr`/`note_lesson`; reviewer has no shell) — and it immunizes us against future floor false positives; the tradeoff is that a hypothetical uncontained bash conversation would stall rather than run. **Adopted — [#40]: `factory/gate-policy.ts` is now the single source of truth for the instance gate policy** (`{tiers:[{tool:"merge_pr"},{tool:"bash",containment:"sandbox"}]}`), written by `factory/main.ts` and consumed unchanged by the boot test (they had drifted: the boot test carried the old `{"issueNumber":N}` destructivePattern that also matched `delegate()` — now impossible, pinned by `test/gate-policy.test.mjs`). The worker prompt's Shell hygiene stopgap was **deleted**: a missing declaration fails as a visible stall, not an unsafe run, so prose workarounds would only hide whether safety came from the guard or from the model complying. Runtime evidence: a real boot logs `[gates] containment-gated floor suppression declared for: bash`. Trade-off accepted knowingly — with the declaration present, an *uncontained* conversation gets `prompt` tier on every bash call (asserted in `test/gate-policy.test.mjs`), and no conversation we create has bash outside the sidecar.

### 5.9 N2 — full-battery confirmation on the final posture (run 2026-10-28)

Posture under test: `main` = `2596e9e` (kernel pin `v0.2.0`, `containment:"sandbox"` declared for worker bash, **no** prompt-level destructive-guard workarounds anywhere), aurora endpoint `Qwen3.8-27B` GGUF on one GPU, Podman sidecars. Fixtures: `factory-fixture` + `factory-fixture-2`. Nine gates, run back-to-back against the real production entrypoint (`factory/main.ts` as a supervised child); every merge below is a real merge into a fixture's `main`.

| Gate | Result | Wall | Evidence |
|---|---|---|---|
| G0 intake exactly-once | **PASS** 20/20 | — (no inference) | retry-dedup, untrusted-delimiting, webhook signature, M3 routing, sender allowlist |
| G1 label → draft PR | **PASS** | **64 s** | fixture #28 → PR #37 (later merged in G4 T1), unattended |
| G2 worker quality | **PASS 2/3** | 97 / 144 / 128 s | #33 PASS, #35 PASS, #34 FAIL on scope only (6 files > bound of 5; suite 53/53, behavior ok, zero human edits). Same PR passes at `--max-files 6` |
| G3 independent reviewer | **PASS** | 46 / 40 / 240 s | T1 caught the seeded trap (verdict=fail naming the root cause); T2 known-good pass; T3 closed loop on live issue #36: worker → review pass → draft opened, gate held, **no merge** |
| G4 merge gate + crash | **PASS** ×2 runs | 19 s / 19 s (re-run: 38 s) | T1 approve → merge, exactly one merge commit; T2 SIGKILL while approval pending → restart over same store → **key survived** → approve → merged exactly once |
| G5 feedback loop | **PASS**, attribution **strong** | 151 s | fixture #19: step A produced the handler-level `instanceof TypeError` patch; after one durable `note_lesson`, step B produced the root fix (`statusCode` on the error class) and the patch did not recur |
| M1 two repos live | **PASS** | 189 s ∥ 161 s | fixture-1 #29 ∥ fixture-2 #18, both evidence-complete, each merged exactly once, simultaneously |
| M2 failure isolation | **PASS** | B: 78 s | A SIGKILLed 6 s into its run; B completed the full chain unaffected and merged once |
| M4 budget enforcement | **PASS** | B: 202 s | A durably aborted by budget (`M4_BUDGET_SECS=20`) with zero side effects (no PR); B completed and merged once |

**Both open honesty items are closed.** (1) G1's 597 s outlier is gone — 64 s unattended on the final tree, comfortably inside the pre-migration 129–433 s band; the earlier number was a single cold run that included intake latency, not drift. (2) This table replaces the piecemeal per-gate numbers in §5.4.

**Six harness defects found while running it** — all fixed here, and each one is the kind of thing that only surfaces when the battery is run end-to-end on a tree where the *fixtures* have moved on:

1. **G2 could not evaluate any issue other than #16–#18.** `checkBehavior()` throws for unknown issues, so newly seeded targets reported `RUN FAIL — no behavior check defined` after a perfectly good worker run. Behavior checks added for #28, #29, #33, #34, #35, #36 (spec-derived from each issue's acceptance criteria, not from the implementation) — and then **removed as a design** in favor of label-keyed oracles, see §5.10.
2. **G2's scope bound was hardcoded and its failure message ambiguous.** Now `--max-files` (default unchanged at 5) and the output distinguishes *out of scope* files from *too many* files. Finding rather than defect: an issue that adds a route legitimately spans six files (`server.mjs`, `invoices.mjs`, `store.mjs`, two test files, README).
3. **G3's T3 "closed loop" leg was vacuous and unasserted.** It hardcoded issue #4 — merged long ago — so the worker produced nothing, it printed `verdict=null draftPR=false gateHeld=false` for ~100 s, and the gate still reported PASS because T3 was never in the verdict. Now parameterized (`--t3-issue`) and a leg that runs without producing a verdict **fails** the gate; verified live on #36.
4. **G3's T2 positive control is also going stale (open).** `agent/issue-1` is merged into main, so its diff vs main is empty — the reviewer said so twice ("git_diff returned an empty changed-file list") and passed it by inspecting state instead of a delta. Needs a policy decision on what "known good" means once branches land; not fixed here.
5. **G4 never exited.** After the crash test it printed `GATE G4: PASS` and then hung indefinitely (one such process was still alive 1 h later, another for 23 h from an earlier session): the SIGKILLed instance's 2 s log-flush interval is only cleared in `close()`, and the crash path re-assigned `instance` without closing the dead one. Fixed by closing before respawn; the re-run exits 0. Also: `--skip-crash` still demanded a valid T2 target (default issue #2) at preflight; now it validates only what will run.
6. **M4's default budget was longer than a typical successful run.** With `M4_BUDGET_SECS=120`, bounded fixture issues finish first, no abort ever fires, and the script waits out its full 20-minute delegate-wait with no diagnostic. Default lowered to 30 s (verified: clean abort, zero side effects) with a comment stating the invariant.

**Fixture bookkeeping.** Targets were seeded as ordinary issues *without* the `agent` label (`factory-fixture` #33 offset paging, #34 PATCH amountCents, #35 status history, #36 413 body cap, #42 `totalCount`, #44 customer-scoped summary, #45 sort; `factory-fixture-2` #18 `?status=` filter, #19 unknown `?priority=` → 400). G1/G2 synthesize the `agent` label inside the webhook event they deliver, so no fixture labeling is needed to drive them. One real defect was found while probing for G5 material and is now fixed by the G5 run: `PUT /invoices/:id/status` with an unknown status returned **500** instead of 4xx (bare `TypeError` from the store translated per-handler) — that is fixture issue #19, still open as a draft PR (#43).

### 5.10 G2's behavior oracles are label-keyed, not issue-number-keyed (2026-10-28)

The nine `if (issueNumber === N)` blocks inside `gates/g2-worker-quality.mjs` were the harness's worst coupling: they hardwired fixture issue numbers into gate code, and a target without a block only announced itself **after** a full worker run (`RUN FAIL — no behavior check defined for issue #34`). They are now twelve modules in `gates/probes/`, selected by labels.

| Label | Role |
|---|---|
| `agent` | **selection** — the same label production intake already gates on, deliberately reused rather than inventing a second selection label that could drift from it. No `--issues` flag means "every open `agent` issue is a target". |
| `probe:<key>` | **oracle key** — exactly one per issue; names `gates/probes/<key>.mjs`. Two is an error (two oracles for one issue means nobody knows which judges it). |

Preflight resolves everything **before any inference call** and fails on: a target with no `probe:*` label; a `probe:*` label with no module (typo, or an oracle deleted under review); more than one probe label; and — the strong one — **an oracle that already passes against fixture `main`**. That last check is fail-to-pass: an oracle which holds on main specifies nothing outstanding, so either the work merged (stale target) or the probe is vacuous. It also caught three brand-new probes in the act of being wrong-or-right rather than letting them quietly judge nothing. `--preflight-only` stops there; `--skip-fail-to-pass` overrides it.

`--regression` runs every oracle against main and classifies: oracles with no live target specify **shipped** work and must still hold (`REGRESS` = a feature broke); an oracle that fails on main while its issue is still open is `UNTARGET` (unsatisfied, should be labeled); one that passes while its issue is a live target is `STALE`. This needed a third category because of what it found immediately: **fixture issue #18 (idempotent status transitions) is not satisfied on main** — its draft PR #27 was opened during the Phase 2 work and never merged, so the oracle failed while the issue stayed open. That is exactly the state a number-keyed harness hides; #18 is now a labeled live target.

Two deliberate choices worth keeping:

- **Oracles live in drydock, not in the fixture repo.** The oracle must not be reachable by the pipeline whose work it judges — a spec an agent can edit is a tautology waiting to happen. Adding or changing an oracle is therefore a reviewed PR here, never a fixture edit. (`sourceIssue` on each module is provenance only — used for regression classification, never for selection.) Caveat recorded honestly: worker bash runs `network=none` and pushes happen orchestrator-side in `factory/open-draft-pr.ts`, so this is tautology-avoidance and defense-in-depth, not a hostile-actor control; labels are GitHub state readable by the instance token, which is why they are resolved once at preflight rather than re-read mid-run.
- ~~**`withServer` still hardcodes `src/server.mjs`**, so oracles only cover `factory-fixture` today.~~ **Closed** — boot recipes moved to `factory/repo-registry.json` (`oracleBoot`) and every probe declares its repo; see §5.11.

Current fixture posture: 6 live targets (`#18`, `#34`, `#35`, `#42`, `#44`, `#45`), 6 further oracles held as regression checks for merged work; verified with `--preflight-only` (all six fail against main) and `--regression` (PASS).

```
node --experimental-strip-types gates/g2-worker-quality.mjs --preflight-only      # resolve + fail-to-pass
node --experimental-strip-types gates/g2-worker-quality.mjs                        # label-discovered full run
node --experimental-strip-types gates/g2-worker-quality.mjs --regression           # oracles vs main
```

**Remaining measurement gap (honest).** The gates record wall time but **not tokens**, so this table cannot be compared token-for-token against the §5.4 numbers (baseline ~81–145K, post-migration 119–220K per issue). The data exists — per-entry `totalTokens` is persisted in the instance's durable store (`entries.record`) — it is simply never snapshotted before the gate tears the instance down. Concrete fix: a helper in `gates/lib.ts` that sums `totalTokens` over the run's conversation tree and returns it alongside `wallSecs`, called by each gate before `instance.close()`. Also unmeasured: contention with >2 concurrent factories on one endpoint, and any model other than the single 27B GGUF we run.

### 5.11 Repo registry: policy separated from deployment, and fixture-2 becomes judgeable (2026-10-28)

§5.10 left one gap — `withServer` hardcoded `src/server.mjs`, so only `factory-fixture` could be judged. Closing it turned into a question the harness had been avoiding: *which repo are we judging, under what rules?* That answer is now a checked-in registry rather than an env var default.

**Three config artifacts, deliberately separate:**

| File | Holds | Checked in? | Failure mode if wrong |
|---|---|---|---|
| `factory/config/<owner>_<repo>.json` | per-repo **runtime** config: model provider, `testCommand`, `setupCommand`, sandbox image, budgets | yes | a run fails or uses the wrong model |
| `fleet/fleet.example.json` (per deployment) | **deployment**: one entry per running factory + its webhook secret + instance token; supervisor rewrites the derived routes file | no (secrets) | nothing starts |
| `factory/repo-registry.json` | **policy**: which repos are managed, `eligibilityLabel`, `autoMerge`, `oracleBoot` | yes | something gets merged that should not have been |

Separating policy from deployment is the point: the registry contains no secrets, so it can be reviewed like code, and "is anything else auto-merging?" is a one-screen question instead of a grep across per-repo files. Two rules make it fail closed (`test/repo-registry.test.mjs`, 12 checks): a **disabled entry may not declare `autoMerge=true`** (a leftover grant on a repo someone disabled is a surprise for whoever re-enables it), and an **enabled entry requires `configFile`**, whose existence is checked at load. Unknown fields are rejected — `{automerge: true}` must not silently mean "not set".

**Oracles are now per-repo.** Each probe exports `repo`, and each registry entry declares `oracleBoot` with explicit port discovery, because the two fixtures genuinely differ: fixture-1 binds port 0 and logs `127.0.0.1:<bound>`, while fixture-2 reads `PORT` and logs **the requested value** — meaningless when we ask for 0. So `portFrom` is either `"stdout"` (parse the log) or `"env"` (we reserve a free port, export it, and wait for the socket to accept). A probe whose `repo` does not match the repo being judged is refused rather than run: an invoice oracle against the jobs service would judge nothing, and might accidentally "pass".

That made fixture-2 judgeable — `gates/probes/jobs-sort-priority.mjs` + issue #11 labeled `agent` + `probe:jobs-sort-priority`, verified **in both directions**: fails against fixture-2 `main`, passes against a locally patched copy (patch never pushed; the point is to prove the oracle is not vacuous in the pass direction, which fail-to-pass alone cannot show). `--regression --repo all` now sweeps every registered repo in one run: 12 oracles hold on fixture-1 `main`, fixture-2's target reports as expected-fail.

**Correction, and it materially shrinks N3.** I reported on 2026-10-28 that "no webhook receiver exists" and that repos come only from a `FIXTURES_REPO` env var. Both were wrong: I grepped the vendored kernel and the gates, not `factory/`. In reality drydock already ships

- `factory/intake.ts` — GitHub webhook adapter with `X-Hub-Signature-256` HMAC verification **before parsing** (constant-time, fails closed on missing, malformed, or mismatched), **per-repo secrets** where signature validity doubles as repo authorization (a payload naming a different repo than the secret that signed it is rejected 403), optional `allowedSenders`, stable `requestId = issue-<n>` for exactly-once under redelivery, JSONL audit log, and a **refusal to bind any non-loopback host without auth**;
- `fleet/supervisor.ts` — one factory instance per managed repo + the adapter, restart-on-fault with backoff, learning each child's ephemeral port from its ready line and rewriting the routes file;
- `gates/g0-intake.mjs`, which already exercises signed delivery, bad-signature rejection, cross-repo rejection and the bind-without-secret refusal — against a local adapter, **never against GitHub**.

So N3 is mostly *operations*, not code: write the deployment fleet file, create the webhook + secret on the repo, decide token scope, run it. Two code gaps were identified — nothing reconciled the supervisor's fleet file with the registry, so **a deployment could run a factory for a repo the policy marks disabled**; and `autoMerge=false` was enforced nowhere in the merge path. **Both closed the same day** (follow-up PR):

1. `fleet/supervisor.ts` calls `checkRegistryPolicy` on every fleet entry **before spawning anything**. The two files mean different things — the fleet file says what should be *running*, the registry says what is *allowed* — and now an unregistered repo fails with the list of permitted ones, while a registered-but-disabled one fails carrying its own `note`.
2. `autoMerge:false` became **capability removal**. `factory/main.ts` resolves policy *first* — before reading per-repo runtime config, so a disabled repo gets a policy explanation instead of a confusing `ENOENT` — and registers `merge_pr` only when the entry allows it. The orchestrator prompt is generated from the same flag (`orchestratorInstructions({autoMerge})`), because an agent told to call a tool it does not have goes looking for another way, and `gh pr merge` is sitting in the worker's shell; the draft-only prompt names those bypass routes explicitly rather than trusting "must not merge" to be read broadly.

Evidence: booting a factory for `lalanikarim/drydock` now dies with `is in the repo registry but disabled: …`; fixture-1 boots unchanged (`ready on http://127.0.0.1:…`); G0 still 20/20; `test/repo-enforcement.test.mjs` (4 checks) covers tool absence, that the two prompt shapes differ only in step 6, and that one disallowed entry poisons an entire fleet file before any child starts.

What this does **not** cover, stated so nobody assumes otherwise: it is not branch protection — a human or any other tool with write access can still merge, and GitHub-side rules remain the only defense there. The check also runs at process start, so an instance already up when policy changes keeps its tools until it restarts (supervisor restart-on-fault makes that window short, not zero). And no live GitHub signature has ever been verified: every G0 delivery is signed locally by the test itself.

```
node --experimental-strip-types gates/g2-worker-quality.mjs --repo lalanikarim/factory-fixture-2 --preflight-only
node --experimental-strip-types gates/g2-worker-quality.mjs --regression --repo all
node --experimental-strip-types --test test/repo-registry.test.mjs      # registry shape + probe/registry cross-checks
node --experimental-strip-types --test test/repo-enforcement.test.mjs   # policy → capabilities
```

### 5.12 What drydock-as-a-managed-repo actually requires (measured 2026-10-28)

N3 has always been described as "onboard drydock under its own factory", which invites thinking about it as a big change. The pipeline's contract with any repo is three things: **clone → setup → `testCommand`**, everything else (review, draft PR, approval) is repo-agnostic. So the question is empirical: can that chain succeed on *this* repo? Measured on a clean clone of `main`, not inferred:

| Step | Result |
|---|---|
| Host clone | `factory/worker.ts` already clones with `--recurse-submodules`, so `vendor/engram` arrives at the pinned tag (`a764e36`, v0.2.0) — the "submodule-aware clone" item on N3's row needed **no code** |
| Dependency install | `npm ci` in the clean clone succeeds (lockfile present; warm npm cache made it ~2 s) |
| Verification command | `npm test` → **exit 0** in that clean clone, with no `.env`, no running supervisor and no container-side work — so a worker's success criterion is satisfiable on drydock as-is |
| Setup container | sandbox image has node v24.22.1 / npm 11.19.1 and the registry is reachable from it (`--network bridge`, `npm ping` → PONG 474 ms), so `setupCommand: "npm ci"` works and lands `node_modules` in the mounted workspace before the sealed run |

Added: `factory/config/lalanikarim_drydock.json` (`testCommand: npm test`, `setupCommand: npm ci`, `wallSecsPerIssue: 2400` — real drydock work spans more files than a fixture issue) and the registry entry now points at it. New invariant in `test/repo-registry.test.mjs`: **every** entry's `configFile` must parse against the runtime schema and agree on repo identity, *including disabled repos* — finding a bad field in drydock's config on the day we enable it is the worst possible time.

The registry entry stays `enabled: false`. What remains before N3 flips it is deployment, plus three risks worth naming now:

- **Recursion.** A repo's own `testCommand` must never include gates that mutate GitHub (G1 opens PRs, G4 merges). `npm test` is safe today precisely because it is unit-only — that is a property to preserve, not an accident to rediscover.
- **A green suite is a weak judge here.** For fixtures we have behavior oracles; for drydock the worker would be graded by the same suite it can edit. G2/G3 should stay in the loop for self-work rather than trusting `npm test` alone.
- **Nothing stops a worker touching `vendor/engram`.** The 5-file / `src|test` scope rule lives in the G2 harness, not the pipeline, and submodule pointer changes are exactly the kind of edit that passes tests while being unacceptable. Candidate fix: a per-repo path allowlist in the registry, enforced by `open_draft_pr` before push.

### 5.13 Path scope: the pipeline cannot change what it is not allowed to touch (2026-10-28)

§5.12 named the risk that stayed unfixed: nothing stopped `open_draft_pr` pushing a branch whose only change was the **`vendor/engram` submodule pointer** — every test passes, and the vendored kernel changes underneath us. Pin discipline is a human decision (tags, review, rollback), so it should be structurally impossible rather than prompted for.

Two mechanisms in `factory/path-scope.ts`, different default posture on purpose:

| Mechanism | Default | Semantics |
|---|---|---|
| `ALWAYS_PROTECTED_PATHS = ["vendor/"]` | **on everywhere**, before any config is consulted | never changeable; forgetting to configure a repo cannot expose the pin, and an allowlist naming `vendor/` does not override it |
| registry `pathAllowlist` | per repo; absent = anything non-protected | fixtures: `src/`, `test/`, `README.md`. drydock: `factory/ fleet/ gates/ test/ research/` — which deliberately excludes `package.json`/`package-lock.json` (dependency and lockfile changes are human-only for self-runs) and `AGENTS.md`/.github |

Prefix matching only (trailing `/` = directory, otherwise exact). No globs: every dialect considered needed its own security review, and top-level prefixes express what we actually want. Registry validation rejects an **empty** allowlist (`[]` would silently forbid all changes), absolute paths, `..`, backslashes and shell metacharacters — same posture as `factory-config.ts`.

The gate runs in `open_draft_pr` **before the reviewer**, so a run that touched something off-limits costs seconds instead of minutes of inference, and it **fails closed** when the diff basis against `origin/main` cannot be computed: pushing unchecked is the unsafe option.

**Verified at three levels.** (1) Unit semantics + registry wiring — `test/path-scope.test.mjs`, 7 checks. (2) The git assumption this rests on is itself pinned by a test that builds a throwaway repo with a real submodule, bumps the pointer, and asserts `git diff --name-only base..branch` reports exactly `["vendor/engram"]` — if git ever surfaces gitlinks differently, the test fails here rather than silently un-enforcing the rule. (3) **Live end-to-end**: a workspace whose only change was `notes.txt` (outside fixture-1's allowlist), a real instance, and a task instructing the orchestrator to open the PR:

```
open_draft_pr result: {"refused":true,"reason":"path scope violation — nothing was pushed or reviewed",
  "offenders":[{"file":"notes.txt","why":"outside this repo's allowlist (src/, test/, README.md)"}], …}
branch pushed to origin? NO — nothing was pushed
```

**Considered and declined:** making the G2 harness read its scope rule from the registry. The harness rule is intentionally stricter (it also bounds file *count*, and it runs on a checkout rather than pre-push), and silently unifying them would couple a review heuristic to a safety control — if one day they must agree, that should be an explicit decision, not a refactor side effect.

**Still true after this:** scope is about paths, not content. A worker can still write terrible code inside `src/`; that is what the reviewer and G2/G3 are for. And `autoMerge` remains separately enforced (§5.11) — path scope says what may change, auto-merge says whether it may land.
