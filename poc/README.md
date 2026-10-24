# Factory PoC — "Issue → Reviewed PR" on Pi Durable

Implementation for [research/poc-plan-factory.md](../research/poc-plan-factory.md). Reuses the durable harness patterns from `../PiDurable/poc` (same pinned dependency versions — `node_modules` here is a symlink to `../PiDurable/poc/node_modules`).

## Status

| Phase | Gate | Status |
|---|---|---|
| 0 — Fixture & intake wiring | G0: exactly-once intake under simulated retry; untrusted delimiting | **PASS** (`node 01-intake-g0.mjs`, 8/8 checks, no GPU needed) |
| 1 — Intake & orchestration | G1: issue → draft PR unattended | wiring complete — `node 02-orchestration-g1.mjs` (needs Aurora + factory-sandbox image) |
| 2 — Worker quality | G2: ≥ 2/3 bounded issues produce passing, scoped PRs | **PASS** — 3/3 (`node 03-worker-quality-g2.mjs`), zero human edits; see plan doc §1c |
| 3 — Independent reviewer | G3: trap caught with correct reason; good branch passed | pending |
| 4 — Evidence & human checkpoint | G4: exactly-once merge across crash | pending |
| 5 — Feedback loop | G5: one verifiable "same mistake doesn't recur" | pending |
| 6 — Measurement & sizing | (no gate) | pending |

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
| `lib/intake.mjs` | Webhook event → `{ requestId: "issue-<n>", content }`; `<untrusted>` delimiting + trusted directive line; JSONL audit log; HTTP server (`POST /webhook/github`) |
| `01-intake-g0.mjs` | G0 battery (in-process stub factory with exactly-once semantics) + `serve` mode for live wiring to a real `/tasks` endpoint |
| `lib/factory.mjs` | Factory process: durable harness + root orchestrator conversation + `POST /tasks` / `GET /health`. Orchestrator gets exactly two tools: `delegate`, `open_draft_pr` |
| `lib/factory-worker.mjs` | `factory.worker` durable task: host-side issue fetch (`gh api`) + fresh clone on `agent/issue-<n>` + per-conversation Podman sandbox; deterministic worker prompt (issue text inside `<untrusted>`) |
| `lib/open-draft-pr.mjs` | Host-side push + DRAFT PR creation (idempotent by head branch); host-verifies the test suite and records it in the PR body. Never merges — Phase 4 owns merging |
| `02-orchestration-g1.mjs` | G1 end-to-end: preflight → factory + intake adapter → simulated webhook delivery → poll for draft PR (objective check) |
| `03-worker-quality-g2.mjs` | G2 battery: run issues end-to-end (or evaluate existing draft PRs with `--allow-existing`) + objective checks (suite, diff scope, live-server behavior, zero human edits); results to `data/g2-results.json` |
| `sandbox-image/Dockerfile` | Worker sandbox image: `node:24-alpine` + git. Build: `podman build -t factory-sandbox:latest poc/sandbox-image/` |

## Design decisions (Phase 1)

- **Stateless adapter, dedup at the durable server.** GitHub redeliveries carry new `X-GitHub-Delivery` ids but the same issue, so `requestId = "issue-<n>"` makes exactly-once hold at the durable server's `submit()` (crash-verified in `../engram/poc/02-durable.mjs`). The adapter keeps a JSONL audit log for replayability.
- **Credentials stay on the host.** The sandbox gets no env vars and network=none. The clone is prepared host-side (token in the clone URL only during clone, then scrubbed from `.git/config`); the worker prompt forbids pushes; `open_draft_pr` does all GitHub writes from the host with stored `gh` auth or `FACTORY_GITHUB_TOKEN`.
- **Deterministic issue flow.** The orchestrator never handles raw issue text — it reads only the trusted directive line (`Work on GitHub issue number: N`) and calls `delegate({issueNumber})`. The worker task fetches the issue itself via `gh api` and renders it inside `<untrusted>` in its prompt. This minimizes model judgment in the wiring; planning quality is exercised in Phases 2/5.
- **Worker sandbox per run.** One Podman container per worker conversation (registry keyed by conversation id, routed via the harness `env()` callback), torn down when the task settles.
- **Branch retry path.** If a crashed prior attempt left a diverged remote `agent/issue-<n>` branch, `open_draft_pr` deletes *that branch only* and re-pushes — never force-pushes shared history.

## Runbook

```bash
# env (see .env.example); poc/.env values are used as fallback
cp .env.example .env   # then fill in

podman build -t factory-sandbox:latest sandbox-image/

node 01-intake-g0.mjs                                # G0 battery (no GPU)
node lib/factory.mjs 9600                            # standalone factory process
node 02-orchestration-g1.mjs --issue 3               # G1 end-to-end (needs Aurora + image)
node 02-orchestration-g1.mjs --issue 3 --request-id issue-3-dev-<ts>   # dev re-run after a failed attempt
node 03-worker-quality-g2.mjs --issues 1,2,3 [--allow-existing]         # G2 battery (needs Aurora + image)
```

## Next (Phase 3)

Independent reviewer: reviewer subagent on its own read-only checkout emits a structured verdict. The negative test is the gate — it must return `fail` with the correct reason on the trap issue (#4) and `pass` on a known-good branch.
