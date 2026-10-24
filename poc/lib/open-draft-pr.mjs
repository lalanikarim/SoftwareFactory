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

const pExecFile = promisify(execFile);

async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

export async function runTestSuite(ws) {
  try {
    const out = await sh("node", ["--test"], { cwd: ws });
    const summaryLine = [...out.split("\n").reverse().find((l) => l.startsWith("# pass")) ?? "", ""];
    return { passed: true, tail: out.split("\n").slice(-6).join("\n") };
  } catch (e) {
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    return { passed: false, tail: out.split("\n").slice(-10).join("\n") };
  }
}

/** Push the branch (replacing a diverged remote agent branch from a crashed prior attempt). */
async function pushBranch(ws, branch, ghToken) {
  const env = { ...process.env, GH_TOKEN: ghToken ?? "" };
  try {
    await sh("git", ["-C", ws, "push", "-u", "origin", branch], { env });
  } catch (e) {
    const msg = String(e.stdout ?? "") + String(e.stderr ?? "");
    if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
      // Only our own agent/issue-* branch may be replaced; nothing else is touched.
      await sh("git", ["-C", ws, "push", "--delete", "origin", branch], { env });
      await sh("git", ["-C", ws, "push", "-u", "origin", branch], { env });
    } else {
      throw new Error(`git push failed: ${msg.slice(0, 400)}`);
    }
  }
}

export function openDraftPrTool({ workDir, fixturesRepo, ghToken = "" }) {
  return defineTool({
    name: "open_draft_pr",
    description:
      "Push the worker's branch agent/issue-<n> and open a DRAFT pull request for it (never merges). Idempotent: returns the existing draft PR if one is already open for the branch. Include the test result in the PR body.",
    parameters: Type.Object({
      issueNumber: Type.Integer(),
      title: Type.String(),
      summary: Type.String(),
    }),
    replay: "unsafe", // external side effects (push + PR create); idempotent by head branch
    execute: async ({ issueNumber, title, summary }) => {
      const ws = join(workDir, `issue-${issueNumber}`);
      const branch = `agent/issue-${issueNumber}`;
      const env = { ...process.env, GH_TOKEN: ghToken };

      // Verify the worker actually committed on the branch.
      const head = await sh("git", ["-C", ws, "rev-parse", "--verify", `refs/heads/${branch}`]);
      const log = await sh("git", ["-C", ws, "log", "--oneline", `-3`, branch]);

      const tests = await runTestSuite(ws);
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
        prUrl = prJson.url;
      } else {
        const body = [
          `Fixes #${issueNumber}.`,
          "",
          summary,
          "",
          "## Worker report",
          "```",
          log,
          "```",
          "",
          `## Test suite (host-verified at PR creation)`,
          tests.passed ? "PASS" : "FAIL",
          "```",
          tests.tail,
          "```",
          "",
          "_Opened as a draft by the software factory PoC. Merge is gated by human approval._",
        ].join("\n");
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
