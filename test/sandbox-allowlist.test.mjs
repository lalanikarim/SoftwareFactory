// Sandbox containment policy (plan §3.6; pattern from engram phase 7): the base
// image must be on a factory-level allowlist and the workspace must live under
// the allowed mount root. Since cutover the policy is passed explicitly by the
// composition (factory/main.ts builds it from the per-repo config + instance
// work root) rather than read from env — the core's own sandbox spec
// validation applies the same allowlist to conversations.

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSandboxSpec, runSetupInContainer } from "../factory/setup-sandbox.ts";

const policy = { allowImages: ["factory-sandbox:latest", "factory-sandbox-node:latest"], mountRoot: "/srv/factory/work" };

test("validateSandboxSpec: allowlisted image under mount root passes", () => {
  for (const image of policy.allowImages) {
    assert.doesNotThrow(() => validateSandboxSpec({ image, workspace: "/srv/factory/work/issue-7", ...policy }));
  }
  // The mount root itself is a legal workspace.
  assert.doesNotThrow(() => validateSandboxSpec({ image: "factory-sandbox:latest", workspace: policy.mountRoot, ...policy }));
});

test("validateSandboxSpec: non-allowlisted image is rejected with the allowlist in the message", () => {
  assert.throws(
    () => validateSandboxSpec({ image: "docker.io/library/alpine:latest", workspace: "/srv/factory/work/issue-7", ...policy }),
    (e) => /sandbox image not allowlisted: docker\.io\/library\/alpine:latest/.test(e.message) && e.message.includes("factory-sandbox-node:latest"),
  );
});

test("validateSandboxSpec: workspace outside the mount root is rejected", () => {
  const bad = "/srv/factory/data/issue-7";
  assert.throws(
    () => validateSandboxSpec({ image: "factory-sandbox:latest", workspace: bad, ...policy }),
    /outside the allowed mount root/,
  );
});

test("validateSandboxSpec: prefix trickery does not pass (root must match on a path boundary)", () => {
  // "/srv/factory/work-evil/..." starts with the root string but is a sibling dir.
  assert.throws(
    () => validateSandboxSpec({ image: "factory-sandbox:latest", workspace: "/srv/factory/work-evil/issue-1", ...policy }),
    /outside the allowed mount root/,
  );
});

test("runSetupInContainer: policy violation rejects before spawning podman", async () => {
  // Would hang/fail if it reached the podman spawn — validation must fire first.
  await assert.rejects(
    runSetupInContainer({ workspace: "/srv/factory/work/issue-3", image: "not-allowed:latest", setupCommand: "npm ci", policy }),
    /sandbox image not allowlisted/,
  );
});
