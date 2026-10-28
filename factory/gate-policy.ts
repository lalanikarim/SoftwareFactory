// Factory-owned approval gate policy, written into every per-repo instance's config/gates.json.
//
// This is the single source of truth: factory/main.ts writes it, factory/pipeline-boot.test.ts
// boots with the same object, and test/gate-policy.test.mjs pins its shape. They had drifted
// before — the boot test carried a destructivePattern matching {"issueNumber":N}, which also
// matches delegate()'s identical arg shape and stalled unattended runs (plan §5.7, Phase 2
// defect (a)). Never add a pattern that matches an arg shape shared by more than one tool.
//
// merge_pr — the only gated tool. Prompt tier: the first call blocks until a human approves its
//   key (D2: no single-use consumption; exactly-once comes from the verified PR state inside the
//   tool, and an approved call re-executes idempotently on crash-retry).
//
// bash — declared `containment: "sandbox"` (kernel v0.2.0, engram#53). Worker bash executes in a
//   sealed Podman sidecar (network=none, workspace-only mount) and `ConversationMeta.sandbox` is
//   precisely the flag that routes it there, so for those conversations the destructive floor is
//   skipped: the container is the protection. This is not "no gate" — an *uncontained*
//   conversation with bash falls back to the prompt tier and stalls (asserted in
//   test/n1-destructive-classification.test.mjs suite D), which is the safe direction, and no
//   conversation we create has bash outside the sidecar: orchestrator tools are
//   delegate/open_draft_pr/merge_pr/note_lesson and the reviewer has no shell. The kernel warns
//   loudly at startup whenever a containment declaration is present (asserted in
//   test/gate-policy.test.mjs), so it can never be enabled silently.
//
// Because this declaration exists, the worker prompt carries NO destructive-guard hygiene rules:
// a missing declaration fails as a visible stall, not as an unsafe run, so prose workarounds
// would only hide whether safety came from the guard or from the model behaving.
export type InstanceGateTier = { tool: string; default?: "prompt"; containment?: "sandbox" };

export type InstanceGatePolicy = { tiers: InstanceGateTier[] };

/** The exact object serialized to each instance's gates.json. */
export function instanceGatesConfig(): InstanceGatePolicy {
  return {
    tiers: [{ tool: "merge_pr" }, { tool: "bash", containment: "sandbox" }],
  };
}
