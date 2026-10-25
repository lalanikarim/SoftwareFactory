# Factory PoC — "Issue → Reviewed PR" on Pi Durable

Implementation for [research/poc-plan-factory.md](../research/poc-plan-factory.md). Reuses the durable harness patterns from `../PiDurable/poc` (same pinned dependency versions — `node_modules` here is a symlink to `../PiDurable/poc/node_modules`).

## Status

| Phase | Gate | Status |
|---|---|---|
| 0 — Fixture & intake wiring | G0: exactly-once intake under simulated retry; untrusted delimiting | **PASS** (`node 01-intake-g0.mjs`, 13/13 checks incl. webhook signature verification, no GPU needed) |
| 1 — Intake & orchestration | G1: issue → draft PR unattended | **PASS** (`node 02-orchestration-g1.mjs`) — issue #3 → draft PR in 361s, zero intervention (needs Aurora + factory-sandbox image) |
| 2 — Worker quality | G2: ≥ 2/3 bounded issues produce passing, scoped PRs | **PASS** — 3/3 (`node 03-worker-quality-g2.mjs`), zero human edits; see plan doc §1c |
| 3 — Independent reviewer | G3: trap caught with correct reason; good branch passed | **PASS** — 3/3 (`node 04-reviewer-g3.mjs`); gate owns its evidence, closed loop on #4 → draft PR in 441s |
| 4 — Evidence & human checkpoint | G4: exactly-once merge across crash | **PASS** (`node 05-merge-gate-g4.mjs`, T1 143s / T2 144s): evidence complete on PR; single-use durable approvals; SIGKILL while approval pending → restart → approve → exactly one merge commit |
| 5 — Feedback loop | G5: one verifiable "same mistake doesn't recur" | **PASS** (`node 06-feedback-g5.mjs`, 306s): baseline arm reproduced the #11 handler-patch mistake; after one recorded lesson, the re-run fixed it at the root (statusCode on the error class) — strong attribution; see plan doc §1f |
| 6 — Measurement & sizing | (no gate) | **DONE** (`node 07-measurement.mjs`): per-issue tokens by role from `pi.usage`, wall time, tool calls, interventions; bounded issues run 129–433s and ~81–145K total tokens on local inference; sizing write-up in plan doc §1g |

## Fixture

[`lalanikarim/factory-fixture`](https://github.com/lalanikarim/factory-fixture) — dependency-free Node ledger service (~500 lines, `node --test`). Seeded issues:

- #1 unknown invoice id returns 500 instead of 404 (bounded)
- #2 add status filter to `GET /invoices` (bounded feature)
- #3 `/summary` counts voided invoices (subtle spec violation)
- #4 `withRetry` never surfaces upstream 5xx errors — **trap**: the obvious timeout fix masks the real bug (HTTP error statuses treated as success, retries never fire); acceptance requires the surfaced error to carry the HTTP status

Issues are intentionally created **without** the `agent` label. Adding the label is the intake trigger — do it only when a phase run is meant to start. (The G1 script delivers a *simulated* webhook event built from the live issue via `gh api`, so no public webhook URL is needed.)

## Files

| File | Purpose |
|---|---|
| `lib/intake.mjs` | Webhook event → `{ requestId: "issue-<n>", content }`; `<untrusted>` delimiting + trusted directive line; JSONL audit log; HTTP server (`POST /webhook/github`) with `X-Hub-Signature-256` verification (constant-time, checked before parsing) and fail-closed host binding |
| `01-intake-g0.mjs` | G0 battery (in-process stub factory with exactly-once semantics; incl. signature checks: valid/missing/wrong/tampered) + `serve` mode for live wiring to a real `/tasks` endpoint (`--host`, secret from `GITHUB_WEBHOOK_SECRET`) |
| `lib/factory.mjs` | Factory process: durable harness + root orchestrator conversation + HTTP surface (`POST /tasks`, `GET /health`, `GET/POST /approvals`, `GET /tool-results`, `GET /lessons`). Orchestrator tools: `delegate`, `open_draft_pr`, `merge_pr`, `note_lesson`. Loads per-repo config (CLI arg or `FACTORY_CONFIG`), falling back to legacy env |
| `lib/factory-config.mjs` | Per-repo config loading + strict validation (multi-repo plan §3.1): repo, sandbox image, setup/test commands (argv-only, no shell metacharacters), budgets; one file per managed repo in `config/` |
| `config/factory-fixture.json` | The fixture repo's config (test command `node --test`, 30-min budget) |
| `lib/factory-worker.mjs` | `factory.worker` durable task: host-side issue fetch (`gh api`) + fresh clone on `agent/issue-<n>` + per-conversation Podman sandbox; deterministic worker prompt (issue text inside `<untrusted>`) |
| `lib/open-draft-pr.mjs` | Host-side push + DRAFT PR creation (idempotent by head branch); host-verifies the test suite; assembles the full evidence body (diff summary, reviewer verdict, test counts, worker report) and refreshes it on existing PRs. Never merges — Phase 4 owns merging |
| `lib/merge-gate.mjs` | Phase 4 merge gate: approval-gated `gh pr merge` with single-use durable approvals (`factory.merge-approval` doc family); pending-approval transcript scan for the `/approvals` endpoint |
| `lib/lessons.mjs` | Phase 5 feedback loop: durable lessons document (host-side file, outlives per-run databases) + orchestrator tool `note_lesson`; every worker prompt includes the lessons in a trusted section at spawn |
| `02-orchestration-g1.mjs` | G1 end-to-end: preflight → factory + intake adapter → simulated webhook delivery → poll for draft PR (objective check) |
| `03-worker-quality-g2.mjs` | G2 battery: run issues end-to-end (or evaluate existing draft PRs with `--allow-existing`) + objective checks (suite, diff scope, live-server behavior, zero human edits); results to `data/g2-results.json` |
| `04-reviewer-g3.mjs` | G3 battery: seeded-bad trap caught, known-good passed, closed loop on the trap issue through review gate → draft PR; results to `data/g3-results.json` |
| `05-merge-gate-g4.mjs` | G4 battery: factory as child process; merge directive → review gate → evidence check → approve via `/approvals` → retry → exactly-one-merge verification; T2 adds SIGKILL while approval pending + restart over the same db; results to `data/g4-results.json`. **Merges the target draft PRs on the fixture repo** |
| `06-feedback-g5.mjs` | G5 battery: arm A (no lessons) → lesson recorded via `note_lesson` → arm B (same issue, lessons active); objective diff classification of fix pattern (root-level statusCode vs handler patch); results to `data/g5-results.json`. **Leaves the target draft PR open** (no merge in this gate) |
| `07-measurement.mjs` | Phase 6 metrics extraction: reads every surviving run database (per-conversation `pi.usage` docs, transcripts, submissions) + battery result JSONs; emits per-run tokens by role, wall time, tool calls, errored calls, driver submissions → `data/phase6-metrics.json`. No inference needed |
| `sandbox-image/Dockerfile` | Worker sandbox image: `node:24-alpine` + git. Build: `podman build -t factory-sandbox:latest poc/sandbox-image/` |

## Design decisions (Phase 1)

- **Stateless adapter, dedup at the durable server.** GitHub redeliveries carry new `X-GitHub-Delivery` ids but the same issue, so `requestId = "issue-<n>"` makes exactly-once hold at the durable server's `submit()` (crash-verified in `../engram/poc/02-durable.mjs`). The adapter keeps a JSONL audit log for replayability.
- **Webhook signature verification is mandatory off-loopback.** An unauthenticated intake endpoint reachable from the network is an injection surface — anyone could submit arbitrary "work" content. So: when `webhookSecret` is set, every request must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, constant-time compare, checked **before** JSON parsing; failures are 403 + audit line); binding any non-loopback host without a secret refuses to start. Loopback without a secret is local-development mode only (the G0 battery). In production the adapter sits behind a TLS-terminating reverse proxy; the signature check authenticates GitHub even if TLS is terminated elsewhere.
  - **Secrets are per-repo, never global.** Each repo's GitHub webhook carries its own secret and each factory verifies with exactly that one — a leak compromises only that repo's intake. When multi-repo mode arrives (one adapter fronting many factories), the adapter will hold a `repo full_name → {secret, /tasks target}` map and verification stays **pre-parse**: the raw body is HMAC-checked against each configured secret in constant time, and the matching secret determines routing — so an event signed with repo A's secret but naming repo B is rejected (403 + audit line), and signature validity doubles as per-repo authorization (spec: `../research/multi-repo-factory-plan.md` §3.2). Org-level webhooks (one secret for all repos) are deliberately avoided: one leak would forge work submissions into every factory.
- **Per-repo config, validated at startup.** Each managed repo has one JSON config (`config/<repo>.json`) defining repo identity, sandbox image, test command, setup command, budgets, and optional per-repo token — the factory fails fast on any schema violation. Commands are executed as argv, never through a shell, and are rejected if they contain shell metacharacters. Env vars remain a fallback for the legacy single-repo wiring; a config file always wins. This is multi-repo plan §3.1 with decision D1 resolved as "B" (factory-side config) for the pilot.
- **Credentials stay on the host.** The sandbox gets no env vars and network=none. The clone is prepared host-side (token in the clone URL only during clone, then scrubbed from `.git/config`); the worker prompt forbids pushes; `open_draft_pr` does all GitHub writes from the host with stored `gh` auth or `FACTORY_GITHUB_TOKEN`.
- **Deterministic issue flow.** The orchestrator never handles raw issue text — it reads only the trusted directive line (`Work on GitHub issue number: N`) and calls `delegate({issueNumber})`. The worker task fetches the issue itself via `gh api` and renders it inside `<untrusted>` in its prompt. This minimizes model judgment in the wiring; planning quality is exercised in Phases 2/5.
- **Worker sandbox per run.** One Podman container per worker conversation (registry keyed by conversation id, routed via the harness `env()` callback), torn down when the task settles.
- **Branch retry path.** If a prior attempt left a diverged remote `agent/issue-<n>` branch, `open_draft_pr` replaces it with `--force-with-lease` — only our own factory-owned branch is ever forced, and the lease refuses to clobber anything unfetched. (Deleting the branch first would auto-close the open PR tracking it, breaking PR continuity.) Shared branches are never touched.
- **Lessons are a host-side file, not a durable doc.** Per-run sqlite databases are wiped between battery runs, but standing lessons must outlive them; `note_lesson` appends to a file (`FACTORY_LESSONS_FILE`, default `data/lessons.md`) that every worker prompt reads at spawn. The orchestrator records one lesson per refused review (its standing instruction); if it skips, the human driver can submit a trusted instruction to record it — counted as an intervention. Writing to the lessons file is the only agent-reachable write outside the sandbox; it has no external side effects and is idempotent per identical line.

## Runbook

```bash
# env (see .env.example); poc/.env values are used as fallback
cp .env.example .env   # then fill in

podman build -t factory-sandbox:latest sandbox-image/

node 01-intake-g0.mjs                                # G0 battery (no GPU)
# Live adapter: loopback dev mode (no signature check — do not expose):
node 01-intake-g0.mjs serve --port 9475 --target http://127.0.0.1:8787/tasks
# Reachable endpoint: non-loopback bind REQUIRES GITHUB_WEBHOOK_SECRET (same value in the GitHub webhook config), behind a TLS-terminating proxy:
GITHUB_WEBHOOK_SECRET=... node 01-intake-g0.mjs serve --host 0.0.0.0 --port 9475 --target http://127.0.0.1:8787/tasks
node lib/factory.mjs 9600                            # standalone factory (legacy env fallback)
node lib/factory.mjs 9600 data/factory.sqlite config/factory-fixture.json   # with per-repo config [port] [dbPath] [configPath]
node 02-orchestration-g1.mjs --issue 3               # G1 end-to-end (needs Aurora + image)
node 02-orchestration-g1.mjs --issue 3 --request-id issue-3-dev-<ts>   # dev re-run after a failed attempt
node 03-worker-quality-g2.mjs --issues 1,2,3 [--allow-existing]         # G2 battery (needs Aurora + image)
node 04-reviewer-g3.mjs                                        # G3 battery (needs Aurora + image)
node 05-merge-gate-g4.mjs [--skip-crash]                       # G4 battery (needs Aurora + image; merges PRs #9/#7 by default — G4_T1_ISSUE / G4_T2_ISSUE to retarget)
node 06-feedback-g5.mjs                                        # G5 battery (needs Aurora + image; two factory runs on G5_ISSUE, default 13)
node 07-measurement.mjs                                          # Phase 6 metrics extraction (no GPU; reads data/*.sqlite)
```

## PoC complete — what's next

All six phases are done: G0–G5 passed and the loop is measured (§1g). The identified next steps, in rough order: real-project readiness (webhook signature verification, per-repo config, stuck-task recovery), cloud offload for the worker role on the long tail, and parallel workers for throughput.
