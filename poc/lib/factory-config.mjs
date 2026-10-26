// Per-repo factory configuration (multi-repo plan §3.1).
//
// One JSON file per managed repo, loaded and validated at factory startup.
// Host concerns live here (repo identity, sandbox image, test command,
// budgets); env vars remain as a fallback for the legacy single-repo wiring
// during transition — a config file always wins when present.
//
// Security note: `testCommand`/`setupCommand` are executed as argv (never
// through a shell) and must not contain shell metacharacters. They come from
// factory-side trusted config, but we keep the surface strict regardless.

import { readFileSync } from "node:fs";

export const DEFAULTS = {
  sandboxImage: "factory-sandbox:latest",
  testCommand: "node --test",
  budgets: { wallSecsPerIssue: 1800, maxReviewRetries: 2 },
  approvalTtlHours: 24,
};

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const NO_SHELL_RE = /[;&|`$<>(){}[\]*!#~]/;

function validateCommand(cmd, field) {
  if (typeof cmd !== "string" || !cmd.trim()) throw new Error(`${field} must be a non-empty string`);
  if (NO_SHELL_RE.test(cmd)) throw new Error(`${field} must not contain shell metacharacters (executed as argv, not via a shell): ${JSON.stringify(cmd)}`);
}

/** Split a validated command into argv (whitespace-separated, no quoting support by design). */
export function commandArgv(cmd) {
  return cmd.trim().split(/\s+/);
}

/** Validate and normalize one repo's config object. Throws on any violation. */
export function validateFactoryConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be a JSON object");
  const known = new Set(["repo", "sandboxImage", "setupCommand", "testCommand", "gitToken", "budgets", "lessonsFile", "approvalTtlHours"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`unknown config field: ${key}`);
  }
  if (typeof raw.repo !== "string" || !REPO_RE.test(raw.repo)) {
    throw new Error(`repo must be "owner/name", got: ${JSON.stringify(raw.repo)}`);
  }
  const testCommand = raw.testCommand ?? DEFAULTS.testCommand;
  validateCommand(testCommand, "testCommand");
  if (raw.setupCommand !== undefined) validateCommand(raw.setupCommand, "setupCommand");
  const sandboxImage = raw.sandboxImage ?? DEFAULTS.sandboxImage;
  if (typeof sandboxImage !== "string" || !sandboxImage.trim()) throw new Error("sandboxImage must be a non-empty string");
  if (raw.gitToken !== undefined && (typeof raw.gitToken !== "string" || !raw.gitToken)) {
    throw new Error("gitToken must be a non-empty string when present");
  }
  const budgets = { ...DEFAULTS.budgets, ...(raw.budgets ?? {}) };
  if (!Number.isInteger(budgets.wallSecsPerIssue) || budgets.wallSecsPerIssue <= 0) {
    throw new Error("budgets.wallSecsPerIssue must be a positive integer");
  }
  if (!Number.isInteger(budgets.maxReviewRetries) || budgets.maxReviewRetries < 0 || budgets.maxReviewRetries > 5) {
    throw new Error("budgets.maxReviewRetries must be an integer in 0..5");
  }
  if (raw.lessonsFile !== undefined && (typeof raw.lessonsFile !== "string" || !raw.lessonsFile.trim())) {
    throw new Error("lessonsFile must be a non-empty string when present");
  }
  let approvalTtlHours = DEFAULTS.approvalTtlHours;
  if (raw.approvalTtlHours !== undefined) {
    if (typeof raw.approvalTtlHours !== "number" || !Number.isFinite(raw.approvalTtlHours) || raw.approvalTtlHours <= 0) {
      throw new Error(`approvalTtlHours must be a positive number, got: ${JSON.stringify(raw.approvalTtlHours)}`);
    }
    approvalTtlHours = raw.approvalTtlHours;
  }
  return {
    repo: raw.repo,
    sandboxImage,
    setupCommand: raw.setupCommand ?? null,
    testCommand,
    gitToken: raw.gitToken ?? "",
    budgets,
    lessonsFile: raw.lessonsFile ?? null,
    approvalTtlHours,
  };
}

/** Load + validate a config file. Returns the normalized config. */
export function loadFactoryConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read/parse factory config at ${path}: ${e.message}`);
  }
  return validateFactoryConfig(raw);
}
