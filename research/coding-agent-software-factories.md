# Coding Agent Software Factories — Research Notes

_Compiled 2026-10-18. Sources: factory.com, islo.dev, warp.dev, sandgarden.com (Ulderico Cirello's "The Evolution of AI Factories"), guild.ai._

## 1. What a "software factory" is

A **software factory** is a managed system for producing software with:

- **Repeatable inputs** — work arrives as tickets, issues, alerts, webhooks, schedules (not a human pasting a prompt)
- **Standardized tooling & environments** — each run gets an isolated machine with the real stack (repo, deps, env vars, DB, services)
- **Measurable output** — cost per run, acceptance rate, human-intervention rate; delivery metrics tied to outcomes, not code volume
- **Retained context / replayability** — starting revision, environment definition, task constraints, model config, commands, and the resulting patch are preserved so any shipped change can be reconstructed

The core distinction from a coding assistant: **the factory is the process around the agents.** Agents are the workers; intake → prepared environments → implementation → independent review → end-to-end verification → feedback loop → human approval is the production line. The agent runs unattended; humans own the merge.

### Historical roots
- Robert Bemer, "software factory" at General Electric (late 1960s)
- Hitachi Software Works (1969)
- Michael Cusumano, *Japan's Software Factories* (1991) — Japanese firms organizing software production around reusable methods/tools
- The agent-native variant extends the old automation (build/test/deploy) into investigation and implementation itself

## 2. Anatomy: layers of a factory

Islo's framework (from 100+ conversations with engineering teams): **compute, security, orchestration, harnesses.**

Warp's integration model — five pieces to connect:

| Piece | What it is |
|---|---|
| **Intake** | Event-based trigger: GitHub label, Linear/Jira status change, Slack mention, PagerDuty alert, cron, webhook. Work starts without a person remembering. |
| **Runtime** | Governed cloud environment scoped to repo + task; isolated machine per run that stays up for hours (long tasks don't die when the connection drops). No standing laptop-level access. |
| **Defined role** | One stage of the SDLC per invocation: triage, implementation, review, or verification. Not one agent doing everything ad hoc. |
| **Handoff & checkpoint** | Output goes to a human approval before merge, or to the next agent in the pipeline (implementation → review). |
| **Measurement** | Cost per run, acceptance rate, intervention frequency — separate from whether the agent is "smart." |

Factory's framing adds three requirements for the feedback loop:
- **Model independence** — model choice can change with the task
- **Sovereign intelligence** — control over the system and accumulated knowledge; data placement per deployment (managed / regional / airgapped)
- **Continual learning** — findings flow across stages (an incident improves a test or review instruction); "a software factory should learn from shipped work"

### The feedback loop (Factory 2.0 framing, Grinberg & Reyes)
Bug reports, conversations, customer feedback, requirements → planned changes → built, tested, reviewed, secured, shipped → monitoring deployed software supplies the next signals. Deployment failure → reproducible test; incident → traceable to revision + config.

## 3. Evolution timeline (per Cirello's "The Evolution of AI Factories")

Ten phases, Nov 2022 → Feb 2026:

1. **Early code completion** (2019–2021) — Tabnine, Kite
2. **"AI pair programmer"** (2021–2023) — GitHub Copilot (June 2021), Cursor (Jan 2023), Windsurf "agentic IDE" (Nov 2024)
3. **Autonomous agent experiments** (early 2023) — GPT-4 (Mar 2023), AutoGPT, BabyAGI. Autonomy alone insufficient; orchestration needed.
4. **Agentic IDEs mature** (2023–2024) — OpenCode (open-source, model-agnostic, terminal-first)
5. **Agent swarms — "just throw tokens at the problem"** (2024) — Devin AI (Cognition, Mar 12 2024), Factory AI GA (May 28 2025), 8090 AI (Chamath Palihapitiya, launched Sep 1 2025). Constrained by context windows; worked in demos, struggled in production.
6. **Foundation model breakthrough** (Feb–Jul 2025) — Claude Code research preview (Feb 24 2025, GA May 22 2025); GPT-5 (Jul 24 2025) with 256K context = the "OH SHIT, I CAN USE THIS" moment. Multi-file, multi-agent workflows became viable.
7. **Agent management tools** (Jul–Oct 2025) — VibeKanban (kanban for agents; >50% of its own code agent-written), Conductor (Mac-native, git worktrees per agent), OpenAI Codex app ("command center," Feb 2 2026).
8. **The technique revolution** (Oct 2025–Jan 2026) — **Ralph Wiggums** (Geoffrey Huntley): a bash loop feeding an agent's output (errors included) back into itself until a stop condition; each iteration is a fresh session, state lives in git history. Cited example: $50k contract for $297 API cost. "Persistence matters more than sophistication." Spawned Loopy, Laravel Ralph, etc.
9. **True orchestrators — first factories** (Jan 2026) — **GasTown** (Steve Yegge, Jan 1 2026): 20–30 parallel Claude Code instances in isolated git worktrees on his Beads memory framework; "Hook" system enforces autonomous execution ("If there is work on your Hook, YOU MUST RUN IT"); described as a "CNC machine for code." Also **Claude Flow** (ruvnet; 64-agent orchestration, MCP server with 87 tools) and **Sgai** (Sandgarden; single GOAL.md file + web dashboard).
10. **Dark factories — humans out of the loop** (Feb 2026) — **Attractor** (StrongDM, ~Feb 7 2026): released as NLSpecs (natural-language specs for building your own factory), not code; DOT/Graphviz pipeline runner; agent writes implementation while a DTU verification system runs thousands of tests iterating until convergence. "Lights-out" development, humans banned from writing code.

**Key insight across the timeline:** coordination matters more than raw agent capability. The bottleneck moves — faster patch creation exposes missing tests, slow environments, and limited review capacity.

## 4. Products & platforms

### Commercial
| Product | Positioning | Notes |
|---|---|---|
| **Factory (factory.com)** | "Agent-native software factory" — Droids plan, build, review, ship under human direction | Droid CLI, desktop/web apps, Droid Computers, Missions (multi-phase work with planning + validation), Automations, Public API. $50M Series B @ $300M (NEA, Sequoia, J.P. Morgan, Nvidia). Terminal-Bench leader. Customers: MongoDB, Chainguard, Groq, Empower, Nav, Comarch, NVIDIA. |
| **Devin (Cognition)** | "First fully autonomous AI software engineer" | Mar 2024; SWE-bench SoTA at launch; Goldman Sachs, Visma deployments. The "throw tokens at it" archetype. |
| **8090 AI** | AI-native SDLC orchestration for whole teams (PM, design, eng, QA) | Chamath Palihapitiya; MCP integration; Planner module. Critics: "vague and quite ordinary." |
| **Warp Factories** | Multi-model, multi-harness factory; Factory MCP as integration point | Teams keep existing agents (Cursor, Claude Code, Codex) and connect them to intake/runtime/review layers. Warp reports 20–30% of its own PRs automated. Closed beta. |
| **Islo** | "Tickets in, PRs out" — automate SDLC processes, not just the agent | Isolated computer per run; evidence attached to PR (test output, browser recordings, gateway log of outbound calls). |
| **Guild.ai** | "Turn tasks into shipped code" | Enterprise software factory product. |
| **Augment Code** | AI-powered delivery / software factory | Enterprise positioning. |
| **Mastra Factory** | Issue → production | Agent framework vendor's factory offering. |

### Open source / community
- **GasTown** (steveyegge) — parallel Claude Code orchestration, git worktrees, Hook system
- **Claude Flow** (ruvnet) — multi-agent swarm orchestration on top of Claude Code
- **Sgai** (sandgardenhq/sgai) — GOAL.md-driven factory with dashboard + GitHub integration
- **Attractor** (strongdm) — dark factory specs, DOT pipeline runner
- **VibeKanban** — kanban board for managing multiple agents
- **Conductor** — Mac app running parallel Claude Code/Codex in worktrees
- **Oh-My-OpenCode** (code-yeongyu) — plugin-as-orchestrator on OpenCode; failure tracking ("two strikes")
- **Superpowers** (obra) — skills framework extending Claude Code rather than replacing it
- **Ralph Wiggums** — technique, not a product: bash loop + fresh sessions + git as memory

## 5. Design principles & best practices (synthesized)

1. **Start with one workflow that's easy to verify.** Bounded objective, known dependencies, testable result, human approval. Usually nightly regression or a single PR-review loop. Expand once you trust what it returns.
2. **Give the agent a defined role before more autonomy.** The most common mistake: skipping straight to "let it merge on its own." A bounded task + human checkpoint first.
3. **Don't standardize on one model/harness too early.** Measure which performs best on *your* codebase; keep model choice per-task (model independence).
4. **Verify with the real stack, not compilation.** Tests run against services that are actually up; drive a real browser when needed. "A change that only compiles does not count as done."
5. **Evidence travels with the diff.** Test output, recordings, gateway logs, audit trails — review is reading, not re-running. Wrong answers become cheap to diagnose.
6. **Keep human approval at the merge.** Blast radius = whatever your existing review process already allows.
7. **Measure outcomes, not code volume.** Cost per run, acceptance rate, human-intervention frequency; connect usage to delivery/quality/business priorities. Distinguish time generating a patch from time correcting/reviewing it.
8. **Fix the repo before scaling agents.** Agent readiness: missing tests, slow environments, ambiguous instructions are what break agent runs. "Increasing the number of sessions will not repair a validation process that cannot distinguish a correct change from a plausible one."
9. **Make the feedback loop close.** Same mistake recurs → turn it into a test, maintained instruction (AGENTS.md), or enforced check. Setup fails repeatedly → repair the environment before increasing task volume.
10. **Replayability is a requirement.** Preserve revision, env definition, constraints, model config, commands, patch. OpenTelemetry export alone isn't enough.
11. **Least privilege for agents.** Scope files, commands, networks, credentials to what each task needs; governed runtime instead of standing developer access.

## 6. Reported production results (customer-reported, not universal)

- **Chainguard** — one two-week Droid session spanning 6 repos, building 80 packages
- **Groq** — 3× faster medium-complexity feature dev; 5× faster quick-turn tasks
- **Empower** — up to 40% reduction in incident response time; up to 50% in PR-approval delays
- **Nav** — doubled feature velocity; 60% less context-switching
- **Warp (internal)** — 20–30% of its own PRs automated through factory setup

## 7. Open questions & critiques

- **Autonomy vs. marketing claims** — Devin's launch raised the bar for "fully autonomous"; skepticism persists about what autonomy actually means in production.
- **Do dark factories work at scale?** Attractor pushes humans fully out of the loop; unproven beyond StrongDM's own use.
- **The bottleneck moves** — patch generation gets cheaper, so review capacity, test coverage, and environment speed become the constraints.
- **Standardization risk** — locking into one vendor/model early; counter-trend is model/harness independence (Factory, Warp explicitly).
- **Data residency & sovereignty** — where sessions, inference, telemetry live matters for regulated industries (airgapped/on-prem offerings are a differentiator).
- **8090's critique as cautionary tale** — AI branding on requirements management isn't a factory; the process around agents is what matters.

## 8. Sources

- Factory: https://factory.com/ · https://factory.com/articles/what-is-a-software-factory
- Islo: https://islo.dev/software-factory/
- Warp: https://www.warp.dev/articles/integrate-ai-coding-agents-software-factory
- Cirello / Sandgarden, "The Evolution of AI Factories": https://www.sandgarden.com/blog/the-evolution-of-ai-factories
- Guild.ai: https://www.guild.ai/product/software-factory
- Augment Code: https://www.augmentcode.com/product/software-factory
- Mastra: https://mastra.ai/factory
- GasTown: https://github.com/steveyegge/gastown · Claude Flow: https://github.com/ruvnet/claude-flow · Sgai: https://github.com/sandgardenhq/sgai
