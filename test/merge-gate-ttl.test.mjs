// Merge-approval TTL auto-deny (multi-repo plan follow-up; pattern from engram
// approvals phase 3): pending merge approvals expire after a configurable
// window and are durably auto-denied with decidedBy "ttl".
//
// The harness-side application lives in findPendingMergeApprovals (needs a live
// factory); this test covers the pure decision logic it applies, plus the
// config field that feeds it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isApprovalExpired, resolveApprovalExpiry } from "../poc/lib/merge-gate.mjs";
import { validateFactoryConfig, DEFAULTS } from "../poc/lib/factory-config.mjs";

const NOW = 1_000_000;
const TTL = 10_000;

test("isApprovalExpired: boundary and legacy semantics", () => {
  assert.equal(isApprovalExpired(NOW - TTL - 1, NOW, TTL), true, "expired past ttl");
  assert.equal(isApprovalExpired(NOW - TTL, NOW, TTL), false, "not expired exactly at ttl");
  assert.equal(isApprovalExpired(NOW - 1, NOW, TTL), false, "fresh record not expired");
  assert.equal(isApprovalExpired(0, NOW, TTL), false, "zero createdAt (legacy) never expires here");
  assert.equal(isApprovalExpired(undefined, NOW, TTL), false, "unknown createdAt never expires here");
  assert.equal(isApprovalExpired(NOW - 1, NOW, 0), true, "zero ttl expires any known age");
});

test("resolveApprovalExpiry: legacy pending record is stamped, clock starts now", () => {
  const doc = { decision: "pending", decidedBy: null, consumed: false }; // no createdAt (pre-field)
  assert.deepEqual(resolveApprovalExpiry(doc, NOW, TTL), { action: "stamp", createdAt: NOW });
});

test("resolveApprovalExpiry: expired pending record is denied", () => {
  const doc = { decision: "pending", decidedBy: null, consumed: false, createdAt: NOW - TTL - 1 };
  assert.deepEqual(resolveApprovalExpiry(doc, NOW, TTL), { action: "deny" });
});

test("resolveApprovalExpiry: fresh pending record is kept", () => {
  const doc = { decision: "pending", decidedBy: null, consumed: false, createdAt: NOW - 5 };
  assert.deepEqual(resolveApprovalExpiry(doc, NOW, TTL), { action: "keep" });
});

test("resolveApprovalExpiry: already-decided records are never touched, even if old", () => {
  const old = NOW - 1_000_000;
  for (const decision of ["approved", "denied"]) {
    const doc = { decision, decidedBy: "human", consumed: false, createdAt: old };
    assert.deepEqual(resolveApprovalExpiry(doc, NOW, TTL), { action: "keep" }, `decision=${decision}`);
  }
  const consumed = { decision: "approved", decidedBy: "human", consumed: true, createdAt: old };
  assert.deepEqual(resolveApprovalExpiry(consumed, NOW, TTL), { action: "keep" });
});

test("approvalTtlHours config: default 24h, custom accepted, invalid rejected", () => {
  const base = { repo: "owner/name" };
  assert.equal(validateFactoryConfig(base).approvalTtlHours, DEFAULTS.approvalTtlHours);
  assert.equal(DEFAULTS.approvalTtlHours, 24);
  assert.equal(validateFactoryConfig({ ...base, approvalTtlHours: 1.5 }).approvalTtlHours, 1.5);
  for (const bad of [0, -5, NaN, Infinity, "24", null]) {
    assert.throws(
      () => validateFactoryConfig({ ...base, approvalTtlHours: bad }),
      /approvalTtlHours must be a positive number/,
      `bad value ${String(bad)}`,
    );
  }
});
