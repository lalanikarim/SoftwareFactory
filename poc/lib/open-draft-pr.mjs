// Host-side open_draft_pr tool: pushes the worker's branch and opens a DRAFT PR.
//
// Security posture: all GitHub credentials stay on the host. The sandbox never
// pushes (worker prompt forbids it; remote URL is scrubbed of tokens). Draft PRs
// are safe side effects — no merge happens here (the Phase 4 approval gate owns
// merging). Idempotent under retry: an existing draft PR for the same head
// branch is returned instead of creating a duplicate.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { commandArgv } from "./factory-config.mjs";

const pExecFile = promisify(execFile);

async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

// Per-repo test command (validated argv, never a shell). `# tests/# pass/# fail`
// counts are parsed only for node --test suites; other commands report
// exit-status + tail so the evidence body stays honest about what was checked.
export async function runTestSuite(ws, testCommand = "node --test") {
  const parse = (out) => ({
    total: lastCount(out, "# tests"),
    pass: lastCount(out, "# pass"),
    fail: lastCount(out, "# fail"),
  });
  const argv = commandArgv(testCommand);
  const [cmd, ...args] = argv;
  const isNodeTest = cmd === "node" && args.includes("--test");
  try {
    const out = await sh(cmd, args, { cwd: ws });
    return { passed: true, ...(isNodeTest ? parse(out) : {}), tail: out.split("\n").slice(-6).join("\n") };
  } catch (e) {
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    return { passed: false, ...(isNodeTest ? parse(out) : {}), tail: out.split("\n").slice(-10).join("\n") };
  }
}

/** Last `# <label> N` summary line of a `node --test` run (undefined if absent). */
function lastCount(out, label) {
  const matches = [...out.matchAll(new RegExp(`^${label} (\\d+)$`, "gm"))];
  return matches.length ? Number(matches.at(-1)[1]) : undefined;
}

/** Per-file diff stat of the branch against its merge base with main. */
async function diffStat(ws, branch) {
  try {
    const base = await sh("git", ["-C", ws, "merge-base", "origin/main", branch]);
    return (await sh("git", ["-C", ws, "diff", "--stat", `${base}..${branch}`])).split("\n").filter(Boolean).join("\n");
  } catch {
    return "(diff stat unavailable)";
  }
}

/** Latest delegate tool result in the orchestrator transcript = the worker's final
 *  report (the evidence-packager's transcript excerpt). */
async function workerReportFromTranscript(api, ctx) {
  try {
    const page = await api.commit((tx) => tx.scanEntries({ conversationId: api.conversationId }, 200), ctx);
    for (const item of page.items) { // descending: first match is the latest
      if ((item.kind ?? "") !== "pi.tool-result") continue;
      const msg = Array.isArray(item.model) ? item.model[0] : undefined;
      if (!msg || msg.toolName !== "delegate") continue;
      const text = (msg.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text.trim()) return text.trim();
    }
  } catch { /* transcript scan is best-effort; fall back to the git log */ }
  return null;
}

/** G4 evidence packager: every non-obvious section of the PR body, assembled from
 *  host-verified facts (diff, suite counts) plus the reviewer verdict and the
 *  worker's final report from the transcript. */
function buildPrBody({ issueNumber, summary, verdict, tests, diffStatText, workerReport, log }) {
  const evidence = (verdict.evidence ?? []).map((e) => `- ${e}`).join("\n");
  const concerns = (verdict.concerns ?? []).length
    ? verdict.concerns.map((c) => `- ${c}`).join("\n")
    : "- none";
  const counts = [tests.total !== undefined && `${tests.total} tests`, tests.pass !== undefined && `${tests.pass} passed`, tests.fail !== undefined && `${tests.fail} failed`]
    .filter(Boolean).join(", ");
  return [
    `Fixes #${issueNumber}.`,
    "",
    summary,
    "",
    "## Diff summary",
    "```",
    diffStatText,
    "```",
    "",
    "## Independent review (read-only subagent)",
    verdict.verdict === "pass" ? "PASS" : `FAIL (${verdict.verdict})`,
    evidence,
    "",
    "Reviewer concerns:",
    concerns,
    "",
    "## Test suite (host-verified at PR creation)",
    tests.passed ? `PASS${counts ? ` — ${counts}` : ""}` : "FAIL",
    "```",
    tests.tail,
    "```",
    "",
    "## Worker report (transcript excerpt)",
    "```",
    workerReport ?? log,
    "```",
    "",
    "_Opened as a draft by the software factory PoC. Merge is gated by human approval (`merge_pr` requires an explicit per-execution approval)._",
  ].join("\n");
}

/** Push the branch. If the remote agent/issue-* branch holds a diverged prior
 *  attempt, replace it with --force-with-lease (safe: only our own factory-owned
 *  branch is ever forced, and the lease refuses to clobber anything we have not
 *  fetched). Deleting the branch first would auto-close the open PR tracking it,
 *  so in-place replacement preserves PR continuity. */
async function pushBranch(ws, branch, ghToken) {
  const env = { ...process.env, GH_TOKEN: ghToken ?? "" };
  try {
    await sh("git", ["-C", ws, "push", "-u", "origin", branch], { env });
  } catch (e) {
    const msg = String(e.stdout ?? "") + String(e.stderr ?? "");
    if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
      await sh("git", ["-C", ws, "push", "--force-with-lease", "origin", branch], { env });
    } else {
      throw new Error(`git push failed: ${msg.slice(0, 400)}`);
    }
  }
}

export function openDraftPrTool({ workDir, fixturesRepo, ghToken = "", modelRef, reviewerTaskDef, testCommand = "node --test" }) {
  return defineTool({
    name: "open_draft_pr",
    description:
      "Push the worker's branch agent/issue-<n> and open a DRAFT pull request for it (never merges). BEFORE pushing it runs an independent read-only review of the committed branch; if the review fails, no push or PR happens and the findings are returned. Idempotent: returns the existing draft PR if one is already open for the branch. Include the test result in the PR body.",
    parameters: Type.Object({
      issueNumber: Type.Integer(),
      title: Type.String(),
      summary: Type.String(),
    }),
    replay: "unsafe", // external side effects (push + PR create); idempotent by head branch
    execute: async ({ issueNumber, title, summary }, api, ctx) => {
      const ws = join(workDir, `issue-${issueNumber}`);
      const branch = `agent/issue-${issueNumber}`;
      const env = { ...process.env, GH_TOKEN: ghToken };

      // Verify the worker actually committed on the branch (cheap; before
      // spending minutes on a review of nothing).
      let head;
      try {
        head = await sh("git", ["-C", ws, "rev-parse", "--verify", `refs/heads/${branch}`]);
      } catch {
        // No local workspace (e.g. after a machine reset): recover from the remote
        // branch if it was pushed by an earlier run of this issue.
        try {
          const authUrl = ghToken
            ? `https://x-access-token:${ghToken}@github.com/${fixturesRepo}.git`
            : `https://github.com/${fixturesRepo}.git`;
          await sh("git", ["clone", "--quiet", "--branch", branch, authUrl, ws]);
          head = await sh("git", ["-C", ws, "rev-parse", "--verify", `refs/heads/${branch}`]);
        } catch (e) {
          return { output: [{ type: "text", text: JSON.stringify({ error: `no local branch ${branch} in ${ws} and no remote branch to recover — the worker did not commit` }) }] };
        }
      }
      const log = await sh("git", ["-C", ws, "log", "--oneline", `-3`, branch]);

      // Structural gate (not prompt-dependent): run an independent read-only
      // review of the committed branch NOW; only push if it passes. The
      // orchestrator model cannot skip this — the gate owns its evidence.
      const reviewId = await api.createTask(
        reviewerTaskDef,
        { branch, issueNumber, ...modelRef },
        { ownership: { kind: "task", taskId: api.taskId } },
        ctx,
      );
      const settled = await api.waitForTask(reviewId, ctx);
      const outcome = settled.state.outcome;
      const verdict = outcome?.status === "completed" ? outcome.result : null;
      if (!verdict || verdict.verdict !== "pass") {
        return {
          output: [{ type: "text", text: JSON.stringify({ refused: true, review: verdict ?? { error: "review did not settle" } }) }],
        };
      }

      const tests = await runTestSuite(ws, testCommand);
      const diffStatText = await diffStat(ws, branch);
      const workerReport = await workerReportFromTranscript(api, ctx);
      const body = buildPrBody({ issueNumber, summary, verdict, tests, diffStatText, workerReport, log });
      await pushBranch(ws, branch, ghToken);

      // Idempotency: reuse an open PR for this head branch if one exists.
      let prJson;
      try {
        const existing = await sh("gh", [
          "pr", "list", "--repo", fixturesRepo, "--state", "open",
          "--head", branch, "--json", "number,url,isDraft",
        ], { env });
        const list = JSON.parse(existing || "[]");
        if (list.length > 0) prJson = list[0];
      } catch { /* gh not authenticated or no PRs — fall through to create */ }

      let prUrl;
      if (prJson) {
        // Refresh the evidence sections on the existing PR (G4: evidence must be
        // complete even when the PR predates the packager).
        await sh("gh", ["pr", "edit", String(prJson.number), "--repo", fixturesRepo, "--body", body], { env });
        prUrl = prJson.url;
      } else {
        const out = await sh("gh", [
          "pr", "create", "--repo", fixturesRepo, "--draft",
          "--head", branch, "--title", title, "--body", body,
        ], { env });
        prUrl = out.split("\n").pop().trim();
      }

      return {
        output: [{ type: "text", text: JSON.stringify({ prUrl, isDraft: true, branch, head, testsPassed: tests.passed }) }],
      };
    },
  });
}
