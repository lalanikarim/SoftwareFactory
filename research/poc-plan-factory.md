# Software Factory PoC Plan — "Issue → Reviewed PR" on Pi Durable

_Date: 2026-10-24 · Status: Phases 0–3 complete (G0, G1, G2, G3 passed) · Phases 4–6 pending · Companion docs: [`coding-agent-software-factories.md`](coding-agent-software-factories.md) (research), [`pi-durable-feasibility.md`](pi-durable-feasibility.md) (feasibility assessment)_

## 1. Context

Three prior bodies of work make this plan possible:

1. **The research** established what a software factory is: repeatable intake, governed runtimes, defined stage roles, independent verification, evidence attached to every change, human approval at merge, and a feedback loop that makes the next task better than the last.
2. **The feasibility assessment** mapped all 11 factory requirements onto Pi Durable primitives and found 9 of them already crash-verified by the companion PoC in `../PiDurable/`.
3. **The PiDurable PoC** proved the expensive unknowns: SIGKILL→resume recovery, exactly-once submissions (`requestId`), crash-durable approval gates, sandboxed per-conversation execution (Podman), lossless SSE streaming, subagent fan-out with role-scoped tools, compaction on a local model, and a 100%-success benchmark battery on Qwen3.8-27B (IQ3_S GGUF) via Unsloth on an RTX 4090.

**What that PoC did *not* prove — and what this PoC exists to test:**

| Unproven question | Phase |
|---|---|
| Can a local 27B model do *real* issue→PR work at acceptable acceptance rate (the toy battery was fib.py-scale)? | 2 |
| Does an independent reviewer role actually catch bad fixes, or just rubber-stamp? | 3 |
| Is the merge approval gate exactly-once with *real git side effects* under crash? | 4 |
| Does the loop close — do review findings change subsequent behavior? | 5 |
| Is webhook intake exactly-once under real retry semantics? | 0/1 |
| What do end-to-end latency and token cost look like on realistic tasks? | 6 |

This PoC deliberately does **not** re-test harness durability, SSE reconnect, sandbox isolation, or compaction — those gates already passed with evidence.

## 1a. Phase 0 results (2026-10-19)

**Gate G0: PASS — 8/8 checks**, no GPU required (`node poc-factory/01-intake-g0.mjs`):

1. Agent-labeled issue event starts exactly one submission (`requestId = issue-<n>`).
2. Simulated double-delivery (new `X-GitHub-Delivery`, same issue) yields **no second run**; the same submission is returned.
3./4. Events without the `agent` label (opened or labeled-with-other) are not forwarded.
5. Late `agent` label on an already-processed issue re-submits to the *same* run — no duplicate.
6. Issue content, including seeded prompt-injection text in the body, is confined to `<untrusted>` delimiters; the do-not-follow wrapper stays outside them.
7. JSONL audit log records every event with delivery id + requestId (replayable intake).
8. Pure intake helpers behave as specified.

**Design decision (F1 resolved):** the adapter is deliberately stateless w.r.t. retries — dedup happens at the durable server's `submit()` via the client-chosen `requestId` (crash-verified in `../PiDurable/poc/02-durable.mjs`, PHASE2-DUP). The adapter keeps a JSONL audit log for replayability rather than its own dedup state.

**Artifacts:**

- Fixture repo: [`lalanikarim/factory-fixture`](https://github.com/lalanikarim/factory-fixture) (private) — dependency-free Node ledger service, 17/17 tests passing. Seeded issues: #1 unknown-id 500→404 (bounded), #2 status filter on `GET /invoices` (bounded feature), #3 `/summary` counts voided invoices (subtle spec violation), #4 `withRetry` never surfaces upstream 5xx errors (**trap** — obvious timeout fix masks the real bug; acceptance requires the surfaced error to carry the HTTP status).
- Implementation: this repo's [`poc/`](../poc/) — `poc/lib/intake.mjs`, `poc/01-intake-g0.mjs` (Phase 0); Phase 1 wiring (`poc/lib/factory.mjs`, `poc/lib/factory-worker.mjs`, `poc/lib/open-draft-pr.mjs`, `poc/02-orchestration-g1.mjs`) lands in the same PR.

  _Location note (2026-10-23): the PoC code initially landed in `PiDurable/poc-factory` (PRs #3/#7 there); it has been relocated to `SoftwareFactory/poc/` so all factory work lives with its plan and results. The duplicate was later removed upstream. (2026-10-24: the `PiDurable` checkout and repo were renamed to `engram` — [`lalanikarim/engram`](https://github.com/lalanikarim/engram); all shared-lib imports in `poc/` now point at `../engram/poc/lib/`.)_

**Next:** Phase 1 (orchestrator wiring → draft PR). Issues are created *without* the `agent` label; labeling is the intake trigger and should happen only when a phase run is meant to start. Phases 2+ require Aurora (Qwen3.8-27B via Unsloth) available.

## 1b. Phase 1 results (2026-10-23)

**Gate G1: PASS** — fixture issue #3 flowed unattended from a simulated webhook delivery to a **draft PR in 361s**, zero human intervention:

```
simulated webhook (issue #3, label agent)
  → intake adapter POST /webhook/github          [requestId=issue-3]
  → factory POST /tasks                          [exactly-once submit]
  → orchestrator (tools: delegate, open_draft_pr only)
  → sandboxed worker (Podman, node+git, network=none, no host env)
      clone on agent/issue-3 → fix + regression test → node --test → commit
  → host-side push + draft PR                    [no merge — Phase 4 owns that]
```

Result: [`lalanikarim/factory-fixture#5`](https://github.com/lalanikarim/factory-fixture/pull/5) (draft, head `agent/issue-3`).

**Worker output quality (first local-model run):** minimal scoped diff — one-line fix in `src/invoices.mjs` (skip voided in totals) plus a 12-line regression test asserting open+paid count and voided is excluded; suite **18/18 host-verified at PR creation**. This is a strong G2 candidate for issue #3.

**Wiring bugs found and fixed during bring-up** (all in `poc/lib/`):
1. Worker task definition must be registered with the harness registry (`extension.tasks`) or the scheduler never dispatches it — task sat `pending` indefinitely.
2. `configure()` requires tool **registration objects**, not name strings (the delta tracker strict-JSON-copies the change; string names yield `undefined`).
3. `CodingTools` must be installed in the registry for the worker's role tools to resolve.

**Notes:** G1 delivers a *simulated* webhook event built from the live issue via `gh api` (no public URL needed). A draft PR now exists for issue #3 — close it before any re-run of G1 for that issue (the script's preflight asserts this). Phases 2–6 remain; Phase 2 runs issues #1, #2 (and a fresh #3 if desired) and applies the objective G2 checks.

## 1c. Phase 2 results (2026-10-23)

**Gate G2: PASS — 3/3** (gate required ≥ 2/3). All three bounded issues produced a passing, scoped draft PR with **zero human edits**, via `poc/03-worker-quality-g2.mjs`:

| Issue | PR | Wall time (webhook → draft PR) | Diff | Suite (host-verified) |
|---|---|---|---|---|
| #1 unknown-id 500→404 | [fixture#6](https://github.com/lalanikarim/factory-fixture/pull/6) | 222s | 3 files: `statusCode=404` on `InvoiceNotFoundError` (router already maps it), comment fix, regression test | 18/18 |
| #2 status filter | [fixture#7](https://github.com/lalanikarim/factory-fixture/pull/7) | 95s | 4 files: query parsing + 400 on unknown status (per acceptance), `STATUSES` export, tests, README docs | 19/19 |
| #3 summary excludes voided | [fixture#5](https://github.com/lalanikarim/factory-fixture/pull/5) | 361s (G1 run) | 2 files: skip voided in totals, regression test | 18/18 |

Objective checks per issue (no model judgment): suite passes on the branch · every changed file under `src/`, `test/`, or `README.md` (≤ 5 files) · the named behavior verified against a live server from the branch (404 shape, filter semantics incl. 4xx on bogus status, voided exclusion arithmetic) · PR opened by the factory with no subsequent human edits.

**F2 resolved positively:** the local Qwen3.8-27B holds the implementation role for bounded, well-specified issues at a 3/3 acceptance rate — no cloud fallback needed for this class of work. Caveats: fixture issues are bounded and checkable; the trap issue (#4) is deliberately untested here (Phase 3); wall times are webhook→PR on Aurora and feed Phase 6 sizing.

## 1d. Phase 3 results (2026-10-24)

**Gate G3: PASS — 3/3.** Reviewer module (`poc/lib/factory-reviewer.mjs`): a read-only subagent role with only `read`, `git_diff` (host-side), `run_tests` (Podman sandbox, no network), and `submit_verdict`. It judges whether the change *actually* satisfies the issue's acceptance criteria — not merely that tests pass. Battery: `poc/04-reviewer-g3.mjs`.

| Test | Input | Result |
|---|---|---|
| T1 negative | Seeded bad branch `agent/issue-4-seeded-bad` (timeout "fix" that resolves with a fake `{error}` object; own suite passes 18/18 — the trap) | **caught=true** — verdict `fail`: reviewer named the root cause (non-2xx still treated as success, so `withRetry` retries never fire), quoted the README retry spec, showed the new test codifies the wrong contract, and flagged downstream data loss in `reporting.mjs` |
| T2 positive control | Known-good `agent/issue-1` (G2's 404 fix) | **passed=true** — verdict `pass` with root-cause evidence (missing `statusCode` on `InvoiceNotFoundError`) and a noted out-of-scope observation (`InvalidTransitionError` still lacks one) |
| T3 closed loop | Trap issue #4 through the full chain: webhook → orchestrator → worker → review → gate | **gateHeld=true** in 441s — worker committed a correct fix (reject with `HttpError` carrying status, bounded timeout, retries actually fire; 20/20 tests), the independent review passed it with evidence + minor concerns, and draft PR [fixture#9](https://github.com/lalanikarim/factory-fixture/pull/9) opened. Zero human intervention |

**Key design outcome — the gate owns its evidence.** Early runs showed the 27B orchestrator reliably *skips* an optional `review` tool step (it went straight to `open_draft_pr`, and even a refusal message didn't make it retry with review). The fix is structural, not prompt-based: **`open_draft_pr` itself runs the independent reviewer on the committed branch before pushing** and refuses (returning the findings) if the verdict isn't `pass`. The orchestrator's flow collapses to `delegate → open_draft_pr`; review can no longer be skipped because it *is* the merge gate. This mirrors real CI: the check runs at the gate, not as an optional agent step.

**Other findings recorded:** (1) pi-durable `PodmanSandboxEnv.exec` timeout unit bug — filed upstream as [engram#14](https://github.com/lalanikarim/engram/issues/14), fixed by PR #15; (2) interrupted factory runs leave stuck tasks that stall the scheduler for tens of minutes — G3 T3 now starts from a fresh `factory.sqlite` each run; (3) the 27B worker on trap issue #4 needs up to ~30 min end-to-end (vs ~7 min on simpler issues) — it explores, dead-ends, and recovers; T3 timeout is 60 min.

## 2. Goal & non-goals

**Goal.** Demonstrate a single-repo factory loop end-to-end: a GitHub issue is picked up automatically, a sandboxed worker agent produces a branch + draft PR, an independent reviewer role verifies it with a machine-readable verdict, evidence (diff summary, test output, transcript excerpts) is attached to the PR, and a human approves the merge via Telegram or web — surviving a crash at every stage without duplicate effects.

**Non-goals (deferred to later phases):**

- Multi-repo coordination, cross-repo dependency ordering
- HA / failover, Postgres-backed storage, multi-Pod scaling
- Running N issues in parallel (throughput is *measured*, not engineered)
- Browser automation, email client, MCP bridge
- Auto-merge: the human checkpoint is a factory requirement, not a PoC limitation

## 3. Assumptions under test

| ID | Assumption | Tested in | If it fails |
|---|---|---|---|
| F1 | Webhook intake with `requestId = issue-id` is exactly-once under retry | Phase 0/1 | Fix adapter idempotency before proceeding |
| F2 | Local model produces passing, scoped PRs for bounded real issues at ≥ 2/3 acceptance | Phase 2 | **Major decision point** — see §6 |
| F3 | Reviewer role catches a seeded bad fix with the correct reason (negative test) and passes good fixes | Phase 3 | Tighten reviewer instructions/checklist; if still unreliable, agent review becomes advisory |
| F4 | Merge approval gate executes the merge exactly once across a mid-approval SIGKILL | Phase 4 | **Stop** — non-negotiable durability failure with real consequences |
| F5 | Review findings feed back into instructions/state so the same mistake doesn't recur | Phase 5 | Feedback loop is manual for now; factory claim limited to "agent runner" not "factory" |
| F6 | End-to-end cost/latency per issue is acceptable for the target workflow (overnight batch, not interactive) | Phase 6 | No gate — data informs model-pool and cloud-fallback decisions |

## 4. Architecture

```
 GitHub (private fixture repo)
   │ issue opened / labeled "agent"
   ▼
┌─ webhook adapter ────────────────────────────────────────────────┐
│ POST /tasks { content: <issue, <untrusted>-delimited>,            │
│               requestId: "issue-<n>" }                            │
└──────────────┬───────────────────────────────────────────────────┘
               ▼
┌─ factory process (one Node process, SQLite storage) ─────────────┐
│  Orchestrator conversation (root)                                 │
│   ├─ tools: delegate, github(read), instructions doc             │
│   ├─ spawns worker subagent ──► sandboxed ExecutionEnv            │
│   │    cwd=/work/fixture, branch agent/issue-<n>                 │
│   │    tools: read/write/edit/bash + git                         │
│   ├─ spawns reviewer subagent ──► own checkout (read-only)       │
│   │    tools: read/bash(tests only)                              │
│   │    emits structuredOutput { verdict, evidence, concerns }    │
│   ├─ evidence packager → PR description + comment                │
│   └─ merge tool (gh pr merge) behind approval hook               │
│        └─ pending-approval doc → Telegram inline button / web UI  │
└───────────────────────────────────────────────────────────────────┘
```

### Reuse vs. build new

| Reuse from `../engram/poc` (as-is or near-as-is) | Build new |
|---|---|
| `lib/model.mjs` — inference host/model wiring (env-driven; was `aurora.mjs`) | `lib/github.mjs` — issue read, branch/commit/push, PR create, comment post tools |
| `lib/approvals.mjs` — durable approval hook + doc family | Reviewer role config + verdict schema (`structuredOutput`) |
| `lib/podman-sandbox.mjs` — sandboxed ExecutionEnv | Evidence packager (diff + test output + transcript excerpts → PR body/comment) |
| Subagent fan-out pattern (`03-subagents.mjs`, `lib/worker.mjs`) | Webhook/intake adapter (issue event → `submit({requestId: "issue-<n>"})`) |
| SSE/Telegram client patterns (`05-sse.mjs`, `06-telegram.mjs`) | Merge-gate tool (`gh pr merge` behind the approval hook) |

### Role configuration

| Role | Model (initially) | Tools | Execution env | Replay policy notes |
|---|---|---|---|---|
| Orchestrator | Qwen3.8-27B | `delegate`, GitHub read tools, instructions doc access | Local (no shell needed) | Read-only tools: `replay: "safe"` |
| Worker | Qwen3.8-27B | `read/write/edit/bash` + git | Podman sandbox, `cwd=/work/fixture` | Git push is external side effect → approval-gated *or* draft-PR only (no force-push; branch-scoped) |
| Reviewer | Qwen3.8-27B (cheaper variant later) | `read`, `bash` restricted to test commands | Own checkout, read-only mount | All tools read-only: `replay: "safe"` |

## 5. Phases & gates

### Phase 0 — Fixture & intake wiring

**Setup.**
- Create a small private GitHub fixture repo (e.g., a ~500-line Node or Python service) with a working test suite.
- Seed **four** issues: three bounded, well-specified tasks ("fix the flaky login test", "add missing error handling in X", "small feature: Y") and **one trap** — an issue where the obvious fix is subtly wrong (e.g., "the retry loop hangs; make it not hang" where the real bug is a missing timeout in the callee).
- Webhook adapter: `issues` event with label `agent` → `POST /tasks { content: <issue rendered as <untrusted> data>, requestId: "issue-<n>" }`.

**Tests.**
1. Open issue #1 → exactly one orchestrator run starts.
2. Simulate webhook double-delivery (replay the same event) → no second run; same submission returned.
3. Issue text in transcript is delimited untrusted data (inspect transcript entries).

**Gate G0:** exactly-once intake under simulated retry; issue content enters as data, not instructions.

### Phase 1 — Intake & orchestration

**Test.** Issue #1 flows unattended: orchestrator reads the issue, plans, spawns the worker subagent in the sandbox on branch `agent/issue-1`, and the worker produces a commit + draft PR (PR opened as *draft*; merge stays gated).

**Gate G1:** a real issue yields a draft PR with no human intervention between webhook and PR creation.

### Phase 2 — Worker quality ⚠️ *the key risk*

**Test.** Run all three good issues end-to-end. Objective checks per issue (no model judgment):
- Test suite passes on the resulting branch.
- Diff is scoped to the issue (no unrelated file churn beyond a tolerance, e.g., ≤ 3 files outside the obvious scope).
- The specific behavior named in the issue is fixed (fixture issues are chosen so this is checkable by a test or script).

**Gate G2:** **≥ 2 of 3 issues produce a passing, scoped PR with zero human edits.** This acceptance rate is the number that decides whether local models can hold the implementation role.

### Phase 3 — Independent reviewer (negative test matters) ✅ *G3 PASS 2026-10-24 — see §1d*

**Setup.** Reviewer subagent: own checkout of the worker's branch, read-only tools plus `bash` restricted to the test suite; emits `structuredOutput`:

```json
{ "verdict": "pass" | "fail",
  "evidence": ["test run output summary", "diff observations"],
  "concerns": [ ... ] }
```

**Tests.**
1. **Negative test (the one that counts):** reviewer runs on the trap issue's worker output → must return `verdict: "fail"` with a reason pointing at the actual bug, not a superficial complaint.
2. Positive control: reviewer runs on a known-good branch → `pass` without spurious concerns.
3. Verdict is machine-consumable: orchestrator branches on it (fail → file findings, do not open PR for merge).

**Gate G3:** trap caught with correct reason; good branch passed. A reviewer that passes everything fails this gate by definition.

### Phase 4 — Evidence & human checkpoint

**Tests.**
1. Evidence packager: on reviewer pass, assemble the PR description (diff summary, test output, relevant transcript excerpts, reviewer verdict) and post it as the PR body/comment. Verify all sections present.
2. Merge gate: `gh pr merge` tool is approval-gated. Approve via Telegram inline button → merge executes.
3. **Crash test:** SIGKILL the factory process while merge-approval is pending → restart → approve → merge executes **exactly once** (verify one merge commit, no duplicate PR state).

**Gate G4:** evidence complete on the PR; exactly-once merge across crash. *Failure here stops the PoC* — it's an exactly-once violation with real side effects.

### Phase 5 — Feedback loop

**Test.** Take a concrete reviewer finding from Phases 2–3 (e.g., "worker didn't add a regression test"). The orchestrator records the lesson in its instructions document (or files a follow-up task). Re-run the same or analogous issue → the corrected behavior appears (regression test present this time).

**Gate G5:** one concrete, verifiable instance of "the same mistake doesn't recur." This is the difference between an agent runner and a factory.

### Phase 6 — Measurement & sizing

**Collect per issue:** tokens in/out (from `pi.usage` doc), wall time, tool-call count, self-corrected errors, human interventions, acceptance (passed G2 checks without edits). Compare against the existing PoC's toy-battery numbers (medians 2.2s / 5.1s / 13.2s per turn) to size real tasks.

**No gate.** This data drives the later decisions: model pool (smaller local models for triage/compaction), optional cloud provider for the worker role, and whether overnight batch throughput on one GPU is acceptable.

## 6. Decision points & fallbacks

| Trigger | Decision / fallback |
|---|---|
| G2 < 2/3 acceptance | Local models not ready for the implementation role. Options, in order: (1) stronger local model if hardware allows; (2) cloud provider for the **worker role only** — provider config is per-conversation and swappable, no re-architecture; (3) descope the factory to triage + review, with human implementation |
| G3 misses the trap after instruction tightening | Agent review becomes advisory (verdict posted on PR, human decides); keep building the loop, revisit with a stronger reviewer model later |
| G4 double-merge or lost merge state | **Stop.** Audit the approval/merge tool's idempotency design before anything else ships; this is the one failure that can't be papered over |
| G5 no observable behavior change | Feedback loop stays manual (human updates instructions); the honest claim becomes "durable agent runner with review gates," not "self-improving factory" |
| Latency/cost in Phase 6 far above toy-battery expectations | Revisit role model assignments and batch cadence before scaling issue volume |

### Backlog (tracked tasks)

- ~~**Inference host / model agnostic wiring.**~~ **Done (2026-10-24).** Upstream: [engram#17](https://github.com/lalanikarim/engram/issues/17) resolved by PR #18 — `poc/lib/model.mjs` with env-driven config (`PI_PROVIDER_ID`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `PI_MODEL_ID`; defaults keep historical behavior). Local: `factory.mjs`, `factory-worker.mjs`, `factory-reviewer.mjs`, and the G3 battery now resolve provider/model via `localModels()`/`providerId()`/`modelId()` — no hardcoded provider ids remain in factory code. Switching inference host is now a `.env` change only; F2's cloud fallback and Phase 6 multi-model sizing are unblocked.

## 7. Measurement plan

| Metric | Source | Used for |
|---|---|---|
| Tokens in/out per conversation | `pi.usage` document (per-conversation tracking) | Cost sizing, Phase 6 decisions |
| Wall time per issue (webhook → merged PR) | Timestamps: submission entry, PR-created tool call, merge commit | Throughput expectations |
| Tool calls / self-corrected errors | Transcript entries | Model reliability trend vs. Phase 7 of the existing PoC |
| Acceptance rate | G2 objective checks | The F2 decision number |
| Human interventions | Approval docs + steer submissions | Autonomy level actually achieved |
| Reviewer precision/recall | G3 outcomes (trap caught, good passed) | Reviewer role viability |

All data lives in committed state (transcripts, documents), so the measurement is replayable — consistent with the factory's own replayability requirement.

## 8. Effort estimate

| Phase | Work | Estimate |
|---|---|---|
| 0 | Fixture repo + seeded issues + webhook adapter + idempotency test | 1–2 days |
| 1 | Orchestrator wiring, worker role config, draft-PR flow | 1 day (mostly reuse) |
| 2 | Run battery + objective check scripts | 0.5–1 day |
| 3 | Reviewer role + verdict schema + negative test | 1 day |
| 4 | Evidence packager + merge gate + crash test | 1 day |
| 5 | Feedback wiring + re-run | 0.5 day |
| 6 | Metrics extraction + write-up | 0.5 day |

**Total: ~5–7 focused days**, with roughly 70% of the plumbing already written in `../engram/poc`. The long pole is not code — it's iterating on issue fixtures and role instructions until G2/G3 behave, which is tuning work, not building.

## 9. Risks (PoC-relevant subset)

| Risk | Severity | Mitigation |
|---|---|---|
| Local-model quality on real tasks (F2) | High | It *is* the point of Phase 2; fallbacks in §6 keep every outcome actionable |
| Reviewer rubber-stamping (F3) | Medium | Negative test is a hard gate; structured verdict forces evidence, not vibes |
| Git side-effect idempotency (F4) | Medium | Branch-scoped pushes only, no force-push, approval-gated merge; crash test is explicit |
| Injection via issue text/comments | Medium | `<untrusted>` delimiters (verified pattern), worker sandbox has no host secrets, reviewer read-only |
| Experimental Pi Durable API shifting mid-PoC | Low–Med | Pin exact versions; harness sits behind the thin HTTP API so breakages are contained |
| Fixture too easy / too hard to discriminate | Medium | Calibrate in Phase 0: a good issue should take ~10–30 tool calls, not 3 or 300 |

## 10. Relationship to the existing PoC — file map

| Existing artifact | Role in this PoC |
|---|---|
| `poc/lib/model.mjs` | Reused as-is (inference host/model wiring, env-driven; was `aurora.mjs`) |
| `poc/lib/approvals.mjs` | Reused; extended with per-execution approval nonces (see §11) |
| `poc/lib/podman-sandbox.mjs` | Reused as-is for worker env; reviewer gets a read-only variant |
| `poc/lib/worker.mjs`, `03-subagents.mjs` | Pattern source for orchestrator + role fan-out |
| `poc/05-sse.mjs`, `06-telegram.mjs` | Client patterns reused for progress streaming + merge-approval buttons |
| `poc/10-bench.mjs` | Battery harness pattern reused for Phase 2 objective checks |

## 11. Conventions (carried into implementation)

- **Request IDs:** `issue-<n>` for intake, `job-<date>-<slug>` for scheduled follow-ups — always client-chosen, never generated server-side, so retries are safe by construction.
- **Branch naming:** `agent/issue-<n>`; one branch per issue; no force-push ever (a new attempt = a new branch).
- **Approval semantics:** use **per-execution nonces** in the approval key (`sha1(tool + args + nonce)`), fixing the per-distinct-action persistence observed in the existing PoC's Phase 4 — for a factory, re-running an approved merge must require fresh approval.
- **Untrusted input:** issue titles/bodies/comments and all fetched content enter transcripts only inside `<untrusted>` delimiters; roles that consume them (orchestrator, reviewer) get no write tools beyond their scoped duties.
- **Version pins:** exact versions of `pi-durable`, `pi-ai`, `chord` recorded in the PoC's lockfile and in this plan's results write-up.
