// Sandbox containment policy (plan §3.6; pattern from engram phase 7): the base
// image must be on a factory-level allowlist and the workspace must live under
// the allowed mount root. The policy comes from env, never per-repo config —
// repo configs may select from the allowlist but not widen it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSandboxSpec, loadSandboxPolicy, SupervisedPodmanSandbox } from "../poc/lib/sandbox-health.mjs";
import { runSetupInContainer } from "../poc/lib/setup-sandbox.mjs";
import { DEFAULTS } from "../poc/lib/factory-config.mjs";

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

test("loadSandboxPolicy: defaults are the factory default image and the work dir", () => {
  delete process.env.SANDBOX_ALLOW_IMAGES;
  delete process.env.SANDBOX_MOUNT_ROOT;
  assert.deepEqual(loadSandboxPolicy("/srv/factory/work"), { allowImages: [DEFAULTS.sandboxImage], mountRoot: "/srv/factory/work" });
});

test("loadSandboxPolicy: env overrides parse (comma list, trimmed, blanks dropped)", () => {
  process.env.SANDBOX_ALLOW_IMAGES = " img-a:latest , ,img-b:latest ";
  process.env.SANDBOX_MOUNT_ROOT = "/mnt/sandboxes";
  try {
    assert.deepEqual(loadSandboxPolicy("/ignored"), { allowImages: ["img-a:latest", "img-b:latest"], mountRoot: "/mnt/sandboxes" });
  } finally {
    delete process.env.SANDBOX_ALLOW_IMAGES;
    delete process.env.SANDBOX_MOUNT_ROOT;
  }
});

test("SupervisedPodmanSandbox: policy violation throws at construction (before any podman call)", () => {
  assert.throws(
    () => new SupervisedPodmanSandbox({ workspace: "/srv/factory/work/issue-9", image: "evil-image:latest", network: "none", policy }),
    /sandbox image not allowlisted/,
  );
  // No podman interaction happened: construction with a valid policy succeeds.
  const ok = new SupervisedPodmanSandbox({ workspace: "/srv/factory/work/issue-9", image: "factory-sandbox:latest", network: "none", policy });
  assert.equal(ok.image, "factory-sandbox:latest");
});

test("runSetupInContainer: policy violation rejects before spawning podman", async () => {
  // Would hang/fail if it reached the podman spawn — validation must fire first.
  await assert.rejects(
    runSetupInContainer({ workspace: "/srv/factory/work/issue-3", image: "not-allowed:latest", setupCommand: "npm ci", policy }),
    /sandbox image not allowlisted/,
  );
});
