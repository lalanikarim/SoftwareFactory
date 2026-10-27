// Merge gate (Phase 4), ported to TS for the core composition.
//
// The factory never merges without a durable human decision — but the gating
// itself is now provided by the CORE approval machinery, not re-implemented
// here (issue #30, D2): `merge_pr` is registered in this instance's gates
// config at the destructive tier (its canonical args match a destructive
// pattern), so every call prompts with explicit acknowledgement and can never
// be auto-approved or covered by an allow-rule. When the hook blocks a call,
// the agent reports the approval key and stops; after a human approves via
// POST /approvals (API/Web/Telegram), the agent retries and the hook passes it.
//
// Exactly-once rests on VERIFIED PR state, not on a consumed flag: the tool
// checks `gh pr` state before acting and verifies `state === "MERGED"` after —
// a re-passed identical call after crash/retry lands on alreadyMerged and
// no-ops. This holds under every crash interleaving (crash after merge →
// alreadyMerged; crash before merge → same PR, same args, re-approved).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

const pExecFile = promisify(execFile);

async function sh(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

export const MERGE_TOOL = "merge_pr";

function ok(payload: unknown) {
  return { output: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function err(message: string) {
  return { output: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

export function mergePrTool({ fixturesRepo, ghToken = "" }: { fixturesRepo: string; ghToken?: string }) {
  return defineTool({
    name: MERGE_TOOL,
    description:
      "Merge the draft pull request for one issue. APPROVAL-GATED (destructive tier): the first call is blocked pending human approval with an approval key — report that key and stop; after a human approves it, call again with the identical arguments. If the PR is already merged, reports alreadyMerged.",
    parameters: Type.Object({ issueNumber: Type.Integer() }),
    replay: "unsafe", // real git side effect; idempotent via the verified PR-state check
    execute: async ({ issueNumber }) => {
      const env = { ...process.env, GH_TOKEN: ghToken };
      const branch = `agent/issue-${issueNumber}`;

      // Locate the PR for this head branch (open preferred, else merged).
      let list: Array<{ number: number; url: string; state: string; isDraft: boolean; mergeCommit?: { oid: string } | null }>;
      try {
        const out = await sh(
          "gh",
          ["pr", "list", "--repo", fixturesRepo, "--state", "all", "--head", branch, "--json", "number,url,state,isDraft,mergeCommit"],
          { env },
        );
        list = JSON.parse(out || "[]");
      } catch (e) {
        return err(`gh pr list failed: ${String((e as Error).message).slice(0, 300)}`);
      }
      const pr = list.find((p) => p.state === "OPEN") ?? list.find((p) => p.state === "MERGED");
      if (!pr) return err(`no pull request found for head branch ${branch} — open_draft_pr has not run`);
      if (pr.state === "MERGED") {
        return ok({ merged: true, alreadyMerged: true, prNumber: pr.number, prUrl: pr.url, mergeCommit: pr.mergeCommit?.oid ?? null });
      }

      // Stale-branch detection: a branch that conflicts with main needs rework
      // (re-run the work directive), not a merge attempt.
      let mergeState: string;
      try {
        const out = await sh("gh", ["pr", "view", String(pr.number), "--repo", fixturesRepo, "--json", "mergeStateStatus"], { env });
        mergeState = JSON.parse(out).mergeStateStatus;
      } catch (e) {
        return err(`merge-state check failed: ${String((e as Error).message).slice(0, 300)}`);
      }
      if (mergeState === "DIRTY") {
        return err(`PR #${pr.number} conflicts with the base branch (mergeStateStatus=DIRTY) — the branch is stale and needs rework via the work directive; no merge was attempted`);
      }

      // A human-approved merge implies review is done: convert draft -> ready
      // (GitHub refuses to merge draft PRs). Idempotent if already ready.
      if (pr.isDraft) {
        try {
          await sh("gh", ["pr", "ready", String(pr.number), "--repo", fixturesRepo], { env });
        } catch (e) {
          return err(`gh pr ready failed: ${(String((e as Error & { stdout?: string }).stdout ?? "") + String((e as Error).message)).slice(0, 400)}`);
        }
      }

      try {
        await sh("gh", ["pr", "merge", String(pr.number), "--repo", fixturesRepo, "--merge"], { env });
      } catch (e) {
        return err(`gh pr merge failed: ${(String((e as Error & { stdout?: string }).stdout ?? "") + String((e as Error).message)).slice(0, 400)}`);
      }

      // Verify the terminal state rather than trusting the CLI exit code.
      let after: { state: string; mergeCommit?: { oid: string } | null };
      try {
        const out = await sh("gh", ["pr", "view", String(pr.number), "--repo", fixturesRepo, "--json", "state,mergeCommit"], { env });
        after = JSON.parse(out);
      } catch (e) {
        return err(`post-merge verification failed: ${(e as Error).message}`);
      }
      if (after.state !== "MERGED") return err(`merge did not settle: state=${after.state}`);
      return ok({ merged: true, alreadyMerged: false, prNumber: pr.number, prUrl: pr.url, mergeCommit: after.mergeCommit?.oid ?? null });
    },
  });
}
