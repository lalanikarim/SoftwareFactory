// Phase 4 merge gate: approval-gated host-side `gh pr merge` (the factory never
// merges without a durable human decision).
//
// Per-execution approval semantics (plan §11): the approval record is SINGLE-USE.
//   1. First call with given args -> REQUIRES APPROVAL + stable key (sha1 of
//      tool name + canonical args). The agent reports the key and stops.
//   2. A human approves the key durably (POST /approvals on the factory, standing
//      in for Telegram inline buttons — same durable-decision mechanism as the
//      engram PoC's approval hook, which is read-only and cannot consume).
//   3. Retry with identical args -> the tool atomically consumes the approval in
//      the same commit as the merge decision, then merges.
//   4. Any further identical call requires fresh approval (the record is consumed).
// Crash ordering is safe either way: if we crash after consuming but before the
// merge lands, the PR-state check at the top of the tool makes a re-approved rerun
// a no-op (alreadyMerged) — exactly-once holds under every interleaving.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineDocFamily, defineTool } from "@earendil-works/pi-durable";

const pExecFile = promisify(execFile);

async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

export const MERGE_TOOL = "merge_pr";

/** Durable per-key approval record. Only the factory's /approvals endpoint
 *  (standing in for the human) writes `decision`; only the tool consumes it.
 *  `createdAt` starts the TTL clock at request time; records created before the
 *  field existed load without it (same doc version, additive field) and get
 *  stamped lazily on first observation by findPendingMergeApprovals. */
export const MergeApprovalDoc = defineDocFamily({
  family: true,
  scope: "session",
  kind: "factory.merge-approval",
  version: 1,
  initial: () => ({ decision: "pending", decidedBy: null, consumed: false, createdAt: 0 }),
});

/** TTL expiry (pattern from engram approvals phase 3): a pending request is
 *  expired once it has been waiting longer than ttlMs. Unknown/zero createdAt
 *  never expires here — the caller stamps legacy records first. */
export function isApprovalExpired(createdAt, now, ttlMs) {
  return Number.isFinite(createdAt) && createdAt > 0 && now - createdAt > ttlMs;
}

/** Decide what the /approvals scan should do with one record. Pure (no I/O);
 *  the caller applies the returned action in a commit.
 *    "stamp" — pending record without createdAt (legacy): start the clock now
 *    "deny"  — pending and past TTL: durably auto-deny (decidedBy: "ttl")
 *    "keep"  — anything else, including already-decided records */
export function resolveApprovalExpiry(doc, now, ttlMs) {
  if (doc.decision !== "pending") return { action: "keep" };
  if (!Number.isFinite(doc.createdAt) || doc.createdAt <= 0) return { action: "stamp", createdAt: now };
  if (isApprovalExpired(doc.createdAt, now, ttlMs)) return { action: "deny" };
  return { action: "keep" };
}

/** Canonical JSON (sorted keys) so identical args hash identically across retries. */
export function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable approval key: identical args map to the same key across retries. */
export function mergeApprovalKey(args) {
  return createHash("sha1").update(MERGE_TOOL).update(stableStringify(args)).digest("hex").slice(0, 12);
}

function ok(payload) {
  return { output: [{ type: "text", text: JSON.stringify(payload) }] };
}
function err(message) {
  return { output: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

export function mergePrTool({ fixturesRepo, ghToken = "" }) {
  return defineTool({
    name: MERGE_TOOL,
    description:
      "Merge the draft pull request for one issue. REQUIRES HUMAN APPROVAL: the first call returns REQUIRES APPROVAL with an approval key — report that key and stop; a human approves it, then call again with the identical arguments. Approvals are single-use. If the PR is already merged, reports alreadyMerged without consuming an approval.",
    parameters: Type.Object({ issueNumber: Type.Integer() }),
    replay: "unsafe", // real git side effect; idempotent via the PR-state check
    execute: async ({ issueNumber }, api, ctx) => {
      const env = { ...process.env, GH_TOKEN: ghToken };
      const branch = `agent/issue-${issueNumber}`;

      // Locate the PR for this head branch (open preferred, else merged).
      let list;
      try {
        const out = await sh(
          "gh",
          ["pr", "list", "--repo", fixturesRepo, "--state", "all", "--head", branch, "--json", "number,url,state,isDraft,mergeCommit"],
          { env },
        );
        list = JSON.parse(out || "[]");
      } catch (e) {
        return err(`gh pr list failed: ${String(e.message).slice(0, 300)}`);
      }
      const pr = list.find((p) => p.state === "OPEN") ?? list.find((p) => p.state === "MERGED");
      if (!pr) return err(`no pull request found for head branch ${branch} — open_draft_pr has not run`);
      if (pr.state === "MERGED") {
        return ok({ merged: true, alreadyMerged: true, prNumber: pr.number, prUrl: pr.url, mergeCommit: pr.mergeCommit?.oid ?? null });
      }

      // Stale-branch detection: a branch that conflicts with main needs rework
      // (re-run the work directive), not a merge attempt.
      let mergeState;
      try {
        const out = await sh("gh", ["pr", "view", String(pr.number), "--repo", fixturesRepo, "--json", "mergeStateStatus"], { env });
        mergeState = JSON.parse(out).mergeStateStatus;
      } catch (e) {
        return err(`merge-state check failed: ${String(e.message).slice(0, 300)}`);
      }
      if (mergeState === "DIRTY") {
        return err(`PR #${pr.number} conflicts with the base branch (mergeStateStatus=DIRTY) — the branch is stale and needs rework via the work directive; no merge was attempted`);
      }

      // Single-use approval: atomically read + consume in one commit.
      const key = mergeApprovalKey({ issueNumber });
      const grant = await api.commit(async (tx) => {
        const d = await tx.doc(MergeApprovalDoc, key, {});
        if (!d.createdAt) d.createdAt = Date.now(); // TTL clock starts at request time
        if (d.decision === "approved" && !d.consumed) {
          d.consumed = true;
          return { granted: true };
        }
        return { granted: false, decision: d.decision, consumed: d.consumed, decidedBy: d.decidedBy ?? null };
      }, ctx);

      if (!grant.granted) {
        const expired = grant.decision === "denied" && grant.decidedBy === "ttl";
        return {
          output: [
            {
              type: "text",
              text: expired
                ? `EXPIRED: approval for ${MERGE_TOOL} on issue #${issueNumber} (PR #${pr.number}) was auto-denied after waiting past the TTL (decidedBy=ttl). A human must re-approve key ${key}. Report this key and STOP — do not retry until a human approves.`
                : `REQUIRES APPROVAL: ${MERGE_TOOL} for issue #${issueNumber} (PR #${pr.number}) requires human approval before it can run. Approval key: ${key}. Report this key and STOP — do not retry until a human approves the key.`,
            },
          ],
          isError: true,
        };
      }

      // A human-approved merge implies review is done: convert draft -> ready
      // (GitHub refuses to merge draft PRs). Idempotent if already ready.
      if (pr.isDraft) {
        try {
          await sh("gh", ["pr", "ready", String(pr.number), "--repo", fixturesRepo], { env });
        } catch (e) {
          return err(`gh pr ready failed: ${(String(e.stdout ?? "") + String(e.stderr ?? "")).slice(0, 400)}`);
        }
      }

      try {
        await sh("gh", ["pr", "merge", String(pr.number), "--repo", fixturesRepo, "--merge"], { env });
      } catch (e) {
        return err(`gh pr merge failed: ${(String(e.stdout ?? "") + String(e.stderr ?? "")).slice(0, 400)}`);
      }

      // Verify the terminal state rather than trusting the CLI exit code.
      let after;
      try {
        const out = await sh("gh", ["pr", "view", String(pr.number), "--repo", fixturesRepo, "--json", "state,mergeCommit"], { env });
        after = JSON.parse(out);
      } catch (e) {
        return err(`post-merge verification failed: ${String(e.message).slice(0, 300)}`);
      }
      if (after.state !== "MERGED") return err(`merge did not settle: state=${after.state}`);
      return ok({ merged: true, alreadyMerged: false, prNumber: pr.number, prUrl: pr.url, mergeCommit: after.mergeCommit?.oid ?? null });
    },
  });
}

/** Scan the root conversation transcript for blocked merge_pr calls and report
 *  each approval key with its durable decision state. Newest block first.
 *
 *  When `ttlMs` is given, pending records are also resolved against the TTL
 *  (engram approvals phase 3 pattern): legacy records without createdAt are
 *  stamped (clock starts at first observation), and expired ones are durably
 *  auto-denied with decidedBy "ttl" — idempotent under concurrent decisions. */
export async function findPendingMergeApprovals(harness, conversationId, ctx, ttlMs = null) {
  // Read-only transaction: entry scans live on the Tx surface.
  const page = await harness.commit((tx) => tx.scanEntries({ conversationId }, 500), ctx);
  const seen = new Map(); // key -> record (first = newest, scan is descending)
  for (const item of page.items) {
    if ((item.kind ?? "") !== "pi.tool-result") continue;
    const s = JSON.stringify(item);
    if (!s.includes('"toolName":"merge_pr"')) continue;
    const m = s.match(/Approval key: ([a-f0-9]{12})/);
    if (!m || seen.has(m[1])) continue;
    const issue = s.match(/issue #(\d+)/);
    const doc = await harness.snapshot(MergeApprovalDoc, m[1], ctx);
    seen.set(m[1], {
      key: m[1],
      issueNumber: issue ? Number(issue[1]) : null,
      decision: doc?.decision ?? "pending",
      decidedBy: doc?.decidedBy ?? null,
      consumed: doc?.consumed ?? false,
      createdAt: doc?.createdAt ?? 0,
    });
  }
  if (ttlMs != null) {
    const now = Date.now();
    for (const rec of seen.values()) {
      const expiry = resolveApprovalExpiry(rec, now, ttlMs);
      if (expiry.action === "keep") continue;
      await harness.commit(async (tx) => {
        const d = await tx.doc(MergeApprovalDoc, rec.key, {});
        if (d.decision !== "pending") return d; // re-check: decided concurrently
        if (expiry.action === "stamp") {
          if (!d.createdAt) d.createdAt = expiry.createdAt;
          return d;
        }
        d.decision = "denied";
        d.decidedBy = "ttl";
        return d;
      }, ctx);
      const fresh = await harness.snapshot(MergeApprovalDoc, rec.key, ctx);
      rec.decision = fresh?.decision ?? rec.decision;
      rec.decidedBy = fresh?.decidedBy ?? null;
      rec.createdAt = fresh?.createdAt ?? 0;
    }
  }
  return [...seen.values()];
}
