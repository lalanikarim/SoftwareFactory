// #47 — approvals must be byte-scoped: merge_pr only lands the commit it was approved for.
//   node --experimental-strip-types --test test/merge-head-binding.test.mjs
//
// The bug being closed: open_draft_pr force-with-leases its branch, so a retry after main moves
// turns head H1 into H2 and regenerates the PR evidence for H2. An approval that said "merge PR #N"
// then landed bytes nobody verified (observed 2026-10-28 on issues #35/#18/#34). Approval keys hash
// the arguments, so headSha in merge_pr's args is what makes the durable decision mean "this commit".

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { headShaMatches, mergePrTool, prStatusTool } from "../factory/merge-gate.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("head sha comparison is exact and full-length", () => {
  assert.equal(headShaMatches(SHA_A, SHA_A), true);
  assert.equal(headShaMatches(SHA_A.toUpperCase(), SHA_A), true, "GitHub returns lowercase; case must not matter");
  assert.equal(headShaMatches(SHA_A, SHA_B), false);
  // Prefixes are refused on purpose: the value is machine-supplied from pr_status/open_draft_pr, so
  // accepting a 7-char prefix would only weaken the binding this parameter exists to create.
  assert.equal(headShaMatches("aaaaaaa", SHA_A), false);
  assert.equal(headShaMatches("", SHA_A), false);
  assert.equal(headShaMatches(undefined, SHA_A), false);
  assert.equal(headShaMatches("HEAD", SHA_A), false);
  assert.equal(headShaMatches(SHA_A, ""), false);
});

test("merge_pr requires headSha; pr_status is read-only and always available", () => {
  const merge = mergePrTool({ fixturesRepo: "octo/thing" });
  assert.ok(merge.parameters.properties.headSha, "headSha must be in the schema — it is what the approval key hashes");
  assert.equal(merge.parameters.required?.includes("headSha"), true);
  assert.equal(merge.replay, "unsafe");
  const status = prStatusTool({ fixturesRepo: "octo/thing" });
  assert.equal(status.replay, "safe", "reading PR state must not need approval, or every merge burns one on discovery");
  assert.ok(!status.parameters.properties.headSha);
});

// Below this line the checks talk to GitHub. They are read-only by construction — a mismatch refusal
// happens before any gh mutation, and pr_status only reads — but they still need a token, so npm test
// stays green offline by skipping.
const REPO = process.env.G4_TEST_REPO ?? "lalanikarim/factory-fixture-2";
// Availability is "can gh talk to GitHub", not "is a token in the environment": the CLI may be
// authenticated by keyring, and npm test has to stay green on a machine with neither.
const haveGh = (() => {
  try {
    return spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

test("a merge request naming the wrong commit is refused, and the current head is disclosed", { skip: !haveGh && "gh not authenticated" }, async () => {
  const branchIssue = Number(process.env.G4_TEST_ISSUE ?? 11);
  const tool = mergePrTool({ fixturesRepo: REPO });
  const res = await tool.execute({ issueNumber: branchIssue, headSha: SHA_A }, {}, {});
  const text = res.output.map((o) => o.text).join("");
  const payload = JSON.parse(text);
  if (payload.alreadyMerged) {
    // Terminal state (issue #11 is merged): the tool must still report whether the commit that landed
    // is the one being asked about, so a stale retry can never claim success for different bytes.
    assert.equal(res.isError, undefined);
    assert.equal(payload.landedHeadMatched, false);
    assert.match(payload.warning, /not the requested/i);
    return;
  }
  assert.equal(res.isError, true);
  assert.match(payload.error, /HEAD MISMATCH/);
  assert.match(payload.error, /[0-9a-f]{40}/, "the refusal must disclose the real head so a correctly scoped request can be made");
  assert.doesNotMatch(payload.error, /merged/i, "a refusal must not read like a merge happened");
});
