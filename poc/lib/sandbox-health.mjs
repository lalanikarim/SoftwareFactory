// Sandbox container health supervision (issue #20).
//
// The worker/reviewer sandbox is a long-lived `engram-sbx-*` Podman container.
// If it dies externally (podman daemon restart, OOM kill, host reboot), every
// subsequent `podman exec` fails with "no container with name or ID ... found",
// and the agent silently retries until the wall-clock budget aborts the run.
// SupervisedPodmanSandbox wraps PodmanSandboxEnv so that:
//   - before each exec, the factory checks whether the container is running;
//   - a dead container is detected, surfaced (onEvent + this.events), and
//     recreated in place (same name / mount / network — the workspace lives on
//     the host mount, so nothing is lost);
//   - if recreation fails, exec surfaces a clear error instead of letting the
//     agent retry-loop against a corpse.
// watchSandboxHealth() adds a periodic liveness poll for tasks that wait on a
// conversation without issuing execs themselves, so a death is detected and
// surfaced even when the agent is mid-turn.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ExecutionError, err } from "@earendil-works/pi-durable/env";
import { PodmanSandboxEnv } from "../vendor/engram/poc/lib/podman-sandbox.mjs";

/** Name prefix of all factory sandbox containers. */
export const CONTAINER_PREFIX = "engram-sbx-";

/** Thrown when a sandbox container is dead and its state cannot be determined or recreated. */
export class SandboxDeadError extends Error {
  constructor(containerId, detail) {
    super(`sandbox container ${containerId} is dead${detail ? `: ${detail}` : ""}`);
    this.name = "SandboxDeadError";
    this.containerId = containerId;
  }
}

/** Run a podman command: resolve stdout on exit 0, reject with the stderr text otherwise. */
export function runPodman(args, context) {
  return new Promise((resolve, reject) => {
    const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    const onAbort = () => child.kill("SIGKILL");
    context?.abortSignal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (e) => {
      context?.abortSignal?.removeEventListener?.("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      context?.abortSignal?.removeEventListener?.("abort", onAbort);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`podman ${args[0]} failed (${code}): ${(errOut || out).trim()}`));
    });
  });
}

/** True when the failure says the container object does not exist. */
function isMissingContainer(e) {
  return /no such object|no container with name or ID|not found/i.test(String(e?.message ?? e));
}

/**
 * PodmanSandboxEnv that supervises its own container. Same options as
 * PodmanSandboxEnv plus:
 *   - onEvent?: (event: string) => void — sink for dead-container events
 *     (default: console.error, so the factory log surfaces every detection);
 *   - podman?: (args: string[], context?) => Promise<string> — injectable
 *     podman runner (tests).
 */
export class SupervisedPodmanSandbox extends PodmanSandboxEnv {
  #inFlight;

  constructor(opts = {}) {
    super(opts);
    this.onEvent = opts.onEvent ?? ((event) => console.error(`[sandbox.health] ${event}`));
    this.podman = opts.podman ?? runPodman;
    /** Dead-container detections, oldest first: { containerId, state, at }. */
    this.events = [];
    this.#inFlight = undefined;
  }

  /** Liveness probe: true only when the container exists and is running. */
  async isAlive(context) {
    let state;
    try {
      state = (await this.podman(["inspect", "--format", "{{.State}}", this.containerId], context)).trim();
    } catch (e) {
      if (isMissingContainer(e)) return false;
      throw new SandboxDeadError(this.containerId, `health check failed: ${e.message}`);
    }
    return state === "running";
  }

  /**
   * Ensure the container is running. If it is dead: record the detection in
   * this.events, surface it via onEvent, and recreate it in place (same name,
   * mount, network). Returns true when a recreation happened. Concurrent calls
   * share one in-flight check so a poll and an exec never double-recreate.
   */
  async ensureAlive(context) {
    if (!this.ready) return false; // never initialized, or already cleaned up
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#ensureAliveInner(context).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #ensureAliveInner(context) {
    if (await this.isAlive(context)) return false;
    this.events.push({ containerId: this.containerId, state: "dead", at: new Date().toISOString() });
    this.onEvent(`container ${this.containerId} is dead — recreating`);
    this.ready = false;
    try {
      await this.podman(["rm", "-f", this.containerId], context);
    } catch { /* already gone */ }
    try {
      mkdirSync(this.workspace, { recursive: true });
      // Same argv as PodmanSandboxEnv.init — the pinned submodule's contract.
      await this.podman(
        ["run", "-d", "--name", this.containerId, "--network", this.network, `-v`, `${this.workspace}:/sandbox`, this.image, "sleep", "infinity"],
        context,
      );
    } catch (e) {
      throw new SandboxDeadError(this.containerId, `recreation failed: ${e.message}`);
    }
    this.ready = true;
    return true;
  }

  /** exec with a liveness gate: a dead container is recreated before the command runs. */
  async exec(command, options, context) {
    try {
      await this.ensureAlive(context);
    } catch (e) {
      this.onEvent(e.message);
      return err(new ExecutionError("spawn_error", e.message));
    }
    return super.exec(command, options, context);
  }
}

/**
 * Periodically poll a sandbox's liveness while a task waits on its conversation.
 * Returns a stop function; the timer is unref'd so it never holds the process open.
 */
export function watchSandboxHealth(sandbox, intervalMs = 30_000) {
  const timer = setInterval(() => {
    sandbox.ensureAlive().catch((e) => sandbox.onEvent(e.message));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
