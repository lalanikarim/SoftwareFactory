# Feasibility Assessment — Building a Software Factory on Pi Durable

_Date: 2026-10-18 · Inputs: `../engram/` (INVESTIGATION.md, PLAN.md, POC-FINDINGS.md, brainstorm-responses.md; checkout was `../PiDurable/` until the 2026-10-24 rename) + `research/coding-agent-software-factories.md`_

## Verdict

**Highly feasible as the foundation for a personal-scale software factory.** Every core factory primitive is a Pi Durable first-class feature, and the engram PoC has already verified — under crash conditions, not just happy paths — nearly all of them. What remains is **glue work** (ticket/PR integration, evidence packaging, CI gating) and two structural risks: **local-model quality on long-horizon coding** and the **experimental API**.

The PoC was scoped as a "personal project brain," but its verified capabilities map almost 1:1 onto the software-factory model. In several respects Pi Durable's guarantees (atomic committed state, exactly-once intake, crash-durable approvals) are *stronger* than what commercial factories advertise — notably on **replayability**, which Factory.com lists as a defining factory property and most products only partially deliver.

---

## 1. Requirement mapping: factory layer → Pi Durable primitive → PoC evidence

| Factory requirement | Pi Durable primitive | PoC status |
|---|---|---|
| **Intake** — work from tickets/webhooks/schedules, not human prompting | `root.submit({content, requestId})` — exactly-once; external systems can safely retry | ✅ Phase 2: double-submit same `requestId` → identical submission id, one execution. Phase 4: duplicate `POST /submit` idempotent (202). |
| **Governed runtime** — isolated machine with the real stack, per task | Per-conversation `ExecutionEnv` (`env(target)` factory); custom env verified with Podman: no host secrets, egress blocked, FS containment | ✅ Phase 5: sandbox conversation and local conversation coexist on one harness; containment guard blocks workspace escape. |
| **Defined role per stage** — triage / implement / review / verify as separate agents | Per-conversation agent config (model, tools, instructions, cwd); subagent tool creates owned conversations with role-scoped tools | ✅ Phase 3a: orchestrator fans out researcher (`web_fetch` only) + worker (coding tools in sandbox) in parallel; results returned to orchestrator. |
| **Independent verification** — "only compiles ≠ done"; tests against real services | Tools run tests/builds via `bash` in the execution env; `structuredOutput` channel for machine-readable verdicts (programs, not just the model, can consume results) | ✅ Phase 1/7: coding tasks verified by objective checks (fib.py runs and prints correct output), 10/10 battery success. |
| **Human checkpoint before merge** — approval gates that survive crashes | `beforeTool` hook + durable decision in session doc family; agent cannot self-approve; decision survives SIGKILL | ✅ Phase 3b: block → approve → retry → executed exactly once, including a true mid-run SIGKILL while approval pending. Live e2e on Telegram with inline buttons (Phase 4b). |
| **Evidence travels with the diff** | Everything is committed state: transcript, tool outputs, usage — all atomically stored; `watch()`/`watchEvents()` streams exact operations | ✅ Phase 4a: SSE cursor reconnect — merged A∪B vs full transcript **identical**, no lost or duplicated entries. Evidence assembly into a PR comment is glue (see §3). |
| **Replayability** — reconstruct how any change was made | Starting revision, constraints, model config, commands, and patch all live in committed state; older messages stay searchable after compaction | ✅ Phase 6: post-compaction recall intact (6/6 facts verbatim); docs co-committed with transcript so app state never disagrees with it. |
| **Long/overnight runs** — multi-day work survives reboots | Checkpointed tasks + `harness.resume()`; interrupted tools surface as explicit "may have partially run" errors for the model to decide on | ✅ Phase 2: SIGKILL mid-run → fresh process resumes → done, no lost work, no silent re-run. |
| **Measurement** — cost/acceptance/intervention rates | Per-conversation usage tracking in `pi.usage` document; tools can report usage | ⚠️ Tracked natively; dashboard is roadmap glue (read-only client on `documentState`). |
| **Least privilege for agents** | Tool selection per conversation (`callers`, `modelTools`); read-only reviewer with own checkout is the documented pattern | ✅ Phase 3a/5: role tool restriction verified; researcher role has no shell. |
| **Multi-client steering** — humans watch and intervene live | Multiplayer attach from committed state; `whenBusy: "steer"` joins after current tool calls | ✅ Phase 4a/b: SSE + Telegram progress streaming with mid-run visibility. |

**Score: 11/11 factory requirements have a verified or native Pi Durable mechanism. 9 are PoC-verified under crash conditions.** The two ⚠️ items (measurement dashboards, evidence packaging) are application glue, not capability gaps.

---

## 2. What the PoC already de-risked (the expensive unknowns)

1. **Durability is real, not marketing.** SIGKILL mid-tool-call → resume → correct continuation; in-flight side effects become explicit interrupted diagnostics instead of silent re-runs. This is the single hardest thing to build from scratch and it's verified.
2. **Exactly-once intake works end-to-end** — the contract a CI job or GitHub webhook needs (`requestId` = run/issue id, safe retries).
3. **Local models are usable for bounded factory tasks.** On Qwen3.8-27B (IQ3_S GGUF, 228k ctx) via Unsloth on an RTX 4090: 100% success across a 5×3-task battery, 0 self-corrected errors in 42 tool calls, median latencies 2.2s (fetch) / 5.1s (coding) / 13.2s (multi-step). Injection probes blocked in both researcher and shell-equipped roles.
4. **Sandbox isolation is achievable on the target hardware** — Podman verified as Docker replacement; per-conversation env routing works from one harness.
5. **Compaction works on local models** with a known sizing rule (`reserveTokens` must exceed pi-ai's 4096-token safety margin) — long factory conversations won't silently degrade to 1-token answers if configured correctly.
6. **Client layer is proven** — SSE cursor reconnect is lossless; Telegram e2e ran live including the full approval loop (buttons + text fallback), with access control via allowlisted user IDs.

---

## 3. Gaps to close (ranked by effort)

### Glue work (days each, all patterns already proven in the PoC)
1. **Ticket/PR integration** — GitHub API tools: issue webhook → `submit({requestId: issue-id})`; on completion, create/update PR via tool; post evidence comment. INVESTIGATION §5 explicitly lists CI/CD + GitHub triage as a use case with `structuredOutput` for machine-readable verdicts. Nothing built yet (PLAN C7: "nothing out of the box").
2. **Evidence packager** — assemble diff + test output + relevant transcript excerpts into the PR description/comment. All data exists in committed state; this is extraction + formatting.
3. **Reviewer role definition** — the factory's independent-review stage: a subagent config with read-only tools + test execution, cheaper model later, its own checkout. The Phase 3a pattern already does exactly this shape.
4. **CI gate** — CI job waits on `submission.wait()`, consumes `structuredOutput` verdict, blocks merge on fail. Trivial given the verified wait/re-acquire API (`harness.submission(id)` after restart).
5. **Measurement dashboard** — read-only client on `pi.usage` + document state: tokens per task, acceptance rate, intervention count.

### Design decisions to make (not gaps, but factory-specific)
- **Approval semantics**: PoC found approvals persist *per distinct action* (sha1 of tool+args), not per execution — re-running an approved action executes again without re-approval. For a factory this is likely wrong: use per-execution nonces or explicit `/revoke`. (Already flagged in POC-FINDINGS Phase 4.)
- **Intake hygiene**: ticket bodies and issue threads are untrusted input → same `<untrusted>` delimiter treatment verified in Phase 7 for web content.
- **Merge ownership**: keep human merge as the checkpoint (per factory best practice); the agent opens PRs, never merges — or gate merge behind an approval hook on a `gh pr merge` tool.

---

## 4. Risks (honest assessment)

| Risk | Severity | Notes / mitigation |
|---|---|---|
| **Local-model quality on long-horizon coding** | **High** | The PoC battery is short bounded tasks (3–9s, ≤23 tool calls). Factory work — multi-file features, cross-repo changes, subtle regressions — is where 27B-class GGUF models fall behind frontier APIs. PLAN.md already names this the "honest risk." Mitigations: role splitting (strongest local model for implementation), verification gates as safety net, provider config stays swappable so a cloud key can be added later without re-architecture. |
| **Inference throughput ceiling** | Medium | One 4090 serves one active Unsloth model; parallel conversations/subagents all contend for it. A factory running N tickets in parallel will queue on inference, not on the harness (which handles concurrency fine). Options: Ollama small models for triage/compaction roles (already available on Aurora), or accept serial throughput at personal scale. |
| **Experimental API** | Medium | Pi Durable is experimental — API changes without notice. Mitigation: pin exact versions (already in the plan), keep the harness behind your own thin API layer so breakages are contained. |
| **Single-owner storage** | Low–Medium | One process owns a storage at a time. Fine for one factory on one box; true HA failover needs a custom Postgres backend (small interface + conformance suite provided). PLAN already accepts this trade. |
| **SQLite last-commit loss on hard power loss** | Low | Worst case: one step reruns — acceptable per PLAN B4. The Phase 2 recovery semantics make this benign in practice. |
| **Injection resistance is behavioral, not structural** | Medium | Phase 7 probes were blocked, but that's a measured property of this model+prompt, not a guarantee. Factory intake multiplies untrusted-input surface (tickets, issue comments, linked pages). Mitigations already designed: researcher role tool-restricted, `<untrusted>` delimiters, approval gates on all external side effects. |
| **Scope creep from "brain" to "factory"** | Medium | The engram PLAN is a personal assistant; the factory layer adds GitHub integration, reviewer roles, and evidence packaging. Recommend building the MVP first (it reuses 100% of the same primitives) and treating the factory as Phase B — see §5. |

---

## 5. Recommended path

**Phase A — the engram MVP (per existing PLAN.md, ~2 weeks).**
Build the brain agent: Telegram + Web UI, web fetch, sandboxed local code gen/test, approval gates. This is not detour work — every primitive it exercises (submissions, SSE, approvals, subagents, sandbox env) is a factory component.

**Phase B — the factory layer (~1–2 weeks of glue).**
1. GitHub tools: issue webhook → `submit` (`requestId` = issue id); PR create/update tool (approval-gated).
2. Reviewer subagent role (read-only + tests, own checkout) with `structuredOutput` verdicts.
3. Evidence packager → PR comment (diff summary, test output, transcript excerpts).
4. CI gate consuming the structured verdict.
5. Measurement: acceptance rate + tokens per task from `pi.usage`.

**Phase C — scale decisions when needed.**
Postgres-backed storage for HA, model pool (Ollama small models for triage/compaction), optional cloud provider for hard tasks, browser automation in the sandbox.

**Start with one workflow that's easy to verify** (factory best practice #1): e.g., "triage + fix flaky tests" or "issue → PR on a single repo with bounded scope." Measure acceptance rate and intervention frequency for a few weeks before adding stages — which is exactly what the `pi.usage` tracking makes cheap.

---

## 6. Bottom line

- **Capability fit: excellent.** Pi Durable is arguably the closest thing to an open, auditable implementation of the software-factory feedback loop — with stronger replayability guarantees than most commercial offerings, and a ~15k-line codebase that's readable (and agent-readable).
- **Evidence quality: unusually strong for a pre-build.** The PoC didn't just smoke-test; it SIGKILL'd processes mid-run, probed prompt injection, measured a full benchmark battery, and ran live e2e with a real Telegram bot. All gates passed; no fallbacks triggered.
- **The binding constraints are model quality and inference throughput on local hardware**, not the harness. If those are acceptable at personal scale (they appear to be for bounded tasks), a working single-repo software factory is a few weeks of glue away from the current PoC state.
