// approvalTtlHours config validation (multi-repo plan follow-up).
//
// NOTE: the TTL *decision logic* itself (expire pending merge approvals,
// stamp legacy records, durable auto-deny with decidedBy "ttl") moved
// upstream into engram core at cutover — it is exercised there by engram's
// own approval tests and end-to-end by gate G4. This file keeps only the
// factory-side config field that feeds it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateFactoryConfig, DEFAULTS } from "../factory/factory-config.ts";

test("approvalTtlHours config: default 24h, custom accepted, invalid rejected", () => {
  const base = { repo: "owner/name", models: { provider: "openai-completions", modelId: "test-model" } };
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
