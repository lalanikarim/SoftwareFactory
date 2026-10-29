// Path scope: which files a pipeline run is allowed to change (§5.13).
//
// Why this exists in the PIPELINE rather than only in the G2 harness: the harness rule (≤5 files,
// under src/ or test/) is a review heuristic that runs after the fact, on one repo, when someone
// chooses to run it. Nothing stopped open_draft_pr from pushing a branch whose only change was the
// vendor/engram submodule pointer — which passes every test in the suite while silently replacing
// the vendored kernel. Pin discipline is a human decision (tags, review, rollback), so a machine
// must not be able to make it as a side effect of "fix this issue".
//
// Two mechanisms, deliberately different in default posture:
//   protectedPaths — never changeable. `vendor/` is protected unconditionally, before any entry's
//                    config is consulted, so forgetting to configure a repo cannot expose the pin.
//   pathAllowlist  — optional strictness per repo. Absent means "any non-protected path", which is
//                    what the fixtures' behavior was before this existed; drydock opts in tighter.
//
// Matching is prefix-based on the repository-relative path: an entry ending in "/" is a directory
// prefix, anything else must match exactly. No globs — every glob dialect tried here ended up
// needing its own security review, and top-level prefixes cover what we actually want to express.

export const ALWAYS_PROTECTED_PATHS = ["vendor/"];

export interface PathScope {
  /** Repo-relative prefixes an agent may change. null = unrestricted (except protectedPaths). */
  allowlist: string[] | null;
  /** Additional never-change prefixes on top of ALWAYS_PROTECTED_PATHS. */
  protectedPaths: string[];
}

export const UNRESTRICTED_SCOPE: PathScope = { allowlist: null, protectedPaths: [] };

function matches(file: string, entry: string): boolean {
  return entry.endsWith("/") ? file.startsWith(entry) : file === entry;
}

export interface ScopeVerdict {
  ok: boolean;
  /** [{ file, why }] — empty when ok. */
  offenders: { file: string; why: string }[];
}

/**
 * Check a changed-file list against a scope. `files` are repository-relative paths exactly as
 * `git diff --name-only` reports them — which is how a submodule pointer change shows up (as the
 * submodule path itself, e.g. "vendor/engram"), so protected prefixes catch it without special
 * casing gitlink entries.
 */
export function checkPathScope(files: string[], scope: PathScope = UNRESTRICTED_SCOPE): ScopeVerdict {
  const protectedPaths = [...ALWAYS_PROTECTED_PATHS, ...scope.protectedPaths];
  const offenders: { file: string; why: string }[] = [];
  for (const file of files) {
    const hitProtected = protectedPaths.find((p) => matches(file, p));
    if (hitProtected) {
      offenders.push({ file, why: `protected path ${hitProtected} (never changed by the pipeline)` });
      continue;
    }
    if (scope.allowlist && !scope.allowlist.some((a) => matches(file, a))) {
      offenders.push({ file, why: `outside this repo's allowlist (${scope.allowlist.join(", ")})` });
    }
  }
  return { ok: offenders.length === 0, offenders };
}

/** One-line refusal text for the orchestrator/PR audience. */
export function formatScopeFailure(verdict: ScopeVerdict): string {
  return verdict.offenders.map((o) => `${o.file}: ${o.why}`).join("; ");
}
