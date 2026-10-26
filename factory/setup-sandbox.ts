// Setup-phase container (multi-repo plan §3.6), ported to TS.
//
// Some managed repos need dependencies installed before tests can run. The
// sealed worker sandbox runs with network=none, so installs happen first in
// a one-shot disposable container that HAS egress:
//
//   podman run --rm --network bridge -v <workspace>:/sandbox -w /sandbox \
//     <image> <setupCommand argv...>
//
// The workspace is a host-mounted volume, so node_modules (or whatever the
// install produces) persists after the container exits. The long-lived worker
// sandbox (owned by the core's SandboxManager) is then sealed — the agent
// never runs in a networked container. Runs are idempotent (setupCommand
// re-runs on task resume) and fail closed: any non-zero exit aborts the worker
// before its conversation starts.

import { spawn } from "node:child_process";

export interface SetupPolicy {
  allowImages: string[];
  mountRoot: string;
}

/** Containment last line (engram phase 7 pattern, plan §3.6): the base image
 *  must be on the factory's allowlist and the workspace must live under the
 *  allowed mount root. Pure — callers apply it before any podman call. */
export function validateSandboxSpec({ image, workspace, allowImages, mountRoot }: { image: string; workspace: string; allowImages: readonly string[]; mountRoot: string }): void {
  if (!allowImages.includes(image)) {
    throw new Error(`sandbox image not allowlisted: ${image} (allowed: ${[...allowImages].join(", ") || "<none>"})`);
  }
  if (workspace !== mountRoot && !workspace.startsWith(`${mountRoot}/`)) {
    throw new Error(`sandbox workspace ${workspace} is outside the allowed mount root ${mountRoot}`);
  }
}

/**
 * Run a repo's setup command in a one-shot networked container.
 * `policy`, when given, is enforced before any podman call.
 */
export async function runSetupInContainer({ workspace, image, setupCommand, timeoutSecs = 900, policy = null }: {
  workspace: string;
  image: string;
  setupCommand: string;
  timeoutSecs?: number;
  policy?: SetupPolicy | null;
}): Promise<void> {
  if (policy) validateSandboxSpec({ image, workspace, ...policy });
  const argv = setupCommand.trim().split(/\s+/);
  const containerId = `factory-setup-${Date.now()}`;
  console.log(`[setup] running ${setupCommand} in one-shot networked container (${containerId})`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "podman",
      ["run", "--rm", "--name", containerId, "--network", "bridge", "-v", `${workspace}:/sandbox`, "-w", "/sandbox", image, ...argv],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`setup command timed out after ${timeoutSecs}s`));
    }, timeoutSecs * 1000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`setup command failed (${signal ?? `exit ${code}`}): ${(errOut || out).trim().slice(-2000)}`));
    });
  });

  console.log(`[setup] setup command succeeded for ${workspace}`);
}
