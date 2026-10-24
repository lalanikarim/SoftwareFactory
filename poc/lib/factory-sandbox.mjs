// Factory sandbox env: fixes a unit mismatch in PodmanSandboxEnv.
//
// The env contract (per NodeExecutionEnv and pi-durable's bash tool) is that
// exec `options.timeout` is in SECONDS. PodmanSandboxEnv.exec passes it straight
// to setTimeout, i.e. milliseconds — so any explicit model-supplied timeout
// kills the command almost instantly and misreports it as a long timeout.
// G1/G2 never hit it because the worker never passed an explicit timeout there;
// the Phase 3 run on issue #4 did, and every verification command "timed out".
//
// PiDurable is owned by another workstream, so we fix it locally: subclass and
// convert seconds -> ms before delegating.

import { PodmanSandboxEnv } from "../../../PiDurable/poc/lib/podman-sandbox.mjs";

export class FactorySandboxEnv extends PodmanSandboxEnv {
  async exec(command, options, context) {
    if (options?.timeout !== undefined) {
      options = { ...options, timeout: options.timeout * 1000 };
    }
    return super.exec(command, options, context);
  }
}
