// Sandbox container health supervision (issue #20): a dead `engram-sbx-*`
// container must be detected and surfaced by the factory — recreated in place
// on the next exec (or a clear spawn_error if recreation fails) — instead of
// causing silent agent retry loops.
//
// No real podman is needed: a fake `podman` executable is placed on PATH and
// models container state through a per-test state file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_PREFIX, SandboxDeadError, SupervisedPodmanSandbox, watchSandboxHealth } from "../poc/lib/sandbox-health.mjs";

const FAKE_PODMAN = `#!/bin/sh
STATE="\${FAKE_PODMAN_STATE:?FAKE_PODMAN_STATE is not set}"
alive() { [ -f "$STATE" ] && grep -qx running "$STATE"; }
last=""
for a in "$@"; do last="$a"; done
case "$1" in
  run)
    if [ -n "\${FAKE_PODMAN_FAIL_RUN:-}" ]; then
      printf 'Error: error reading from socket: connection refused\\n' >&2
      exit 125
    fi
    name=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--name" ]; then name="$a"; fi
      prev="$a"
    done
    printf 'running\\n' > "$STATE"
    printf 'fake-%s\\n' "$name"
    ;;
  rm)
    : ;;
  inspect)
    if [ -n "\${FAKE_PODMAN_FAIL_INSPECT:-}" ]; then
      printf 'Error: cannot connect to socket\\n' >&2
      exit 125
    fi
    if alive; then
      echo running
    else
      printf 'Error: no such object "%s"\\n' "$last" >&2
      exit 1
    fi
    ;;
  exec)
    if alive; then
      exit 0
    fi
    printf 'Error: no container with name or ID "%s" found\\n' "$4" >&2
    exit 125
    ;;
esac
exit 0
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Put the fake podman on PATH; restore the environment when the test ends. */
async function setupFakePodman(t) {
  const dir = await mkdtemp(join(tmpdir(), "fake-podman-"));
  await writeFile(join(dir, "podman"), FAKE_PODMAN, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldState = process.env.FAKE_PODMAN_STATE;
  process.env.PATH = `${dir}${oldPath ? `:${oldPath}` : ""}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    if (oldState === undefined) delete process.env.FAKE_PODMAN_STATE;
    else process.env.FAKE_PODMAN_STATE = oldState;
    await rm(dir, { recursive: true, force: true });
  });
}

/** One sandbox + its fake-podman state file + an event collector. */
async function makeSandbox(t) {
  const ws = await mkdtemp(join(tmpdir(), "sbx-ws-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const stateFile = join(ws, "container-state");
  process.env.FAKE_PODMAN_STATE = stateFile;
  const events = [];
  const sandbox = new SupervisedPodmanSandbox({
    workspace: ws,
    image: "factory-sandbox:latest",
    network: "none",
    onEvent: (e) => events.push(e),
  });
  return { sandbox, stateFile, events };
}

const state = async (stateFile) => (await readFile(stateFile, "utf8")).trim();
const killContainer = (stateFile) => writeFile(stateFile, "exited\n");

test("sandbox container id follows the engram-sbx- prefix and init starts it", async (t) => {
  await setupFakePodman(t);
  const { sandbox, stateFile } = await makeSandbox(t);
  assert.ok(sandbox.containerId.startsWith(CONTAINER_PREFIX), `unexpected container id ${sandbox.containerId}`);
  await sandbox.init();
  assert.equal(sandbox.ready, true);
  assert.match(await state(stateFile), /^running$/);
});

test("exec against a live container is untouched by the health gate", async (t) => {
  await setupFakePodman(t);
  const { sandbox, stateFile, events } = await makeSandbox(t);
  await sandbox.init();
  const res = await sandbox.exec("node --version", { timeout: 30 });
  assert.equal(res.ok, true);
  assert.equal(res.value.exitCode, 0);
  assert.equal(events.length, 0, "no health events while the container is alive");
  assert.match(await state(stateFile), /^running$/);
});

test("a dead container is detected, surfaced, and recreated on the next exec", async (t) => {
  await setupFakePodman(t);
  const { sandbox, stateFile, events } = await makeSandbox(t);
  await sandbox.init();
  await killContainer(stateFile); // simulate an external death (daemon restart / OOM)

  const res = await sandbox.exec("node --version", { timeout: 30 });
  assert.equal(res.ok, true, "exec succeeds after transparent recreation");
  assert.equal(res.value.exitCode, 0);
  assert.match(await state(stateFile), /^running$/, "container recreated in place");

  assert.equal(sandbox.events.length, 1);
  assert.equal(sandbox.events[0].containerId, sandbox.containerId);
  assert.ok(events.some((e) => e.includes(sandbox.containerId) && /dead/.test(e)),
    `detection was not surfaced: ${JSON.stringify(events)}`);
});

test("concurrent execs share one recreation", async (t) => {
  await setupFakePodman(t);
  const { sandbox, stateFile } = await makeSandbox(t);
  await sandbox.init();
  await killContainer(stateFile);

  const [a, b] = await Promise.all([
    sandbox.exec("node --version", { timeout: 30 }),
    sandbox.exec("node --version", { timeout: 30 }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(sandbox.events.length, 1, "exactly one dead-container detection/recreation");
});

test("recreation failure surfaces a clear spawn_error instead of a silent retry loop", async (t) => {
  await setupFakePodman(t);
  const { sandbox, stateFile, events } = await makeSandbox(t);
  await sandbox.init();
  await killContainer(stateFile);

  process.env.FAKE_PODMAN_FAIL_RUN = "1";
  let res;
  try {
    res = await sandbox.exec("node --version", { timeout: 30 });
  } finally {
    delete process.env.FAKE_PODMAN_FAIL_RUN;
  }
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "spawn_error");
  assert.match(res.error.message, /is dead/);
  assert.match(res.error.message, /recreation failed/);
  assert.ok(events.some((e) => e.includes(sandbox.containerId)), "detection surfaced even when recreation fails");
});

test("isAlive reports running, dead (exited or removed), and indeterminate states", async (t) => {
  await setupFakePodman(t);
  const { sandbox, stateFile } = await makeSandbox(t);
  await sandbox.init();
  assert.equal(await sandbox.isAlive(), true);

  await killContainer(stateFile);
  assert.equal(await sandbox.isAlive(), false, "exited container is dead");

  await unlink(stateFile);
  assert.equal(await sandbox.isAlive(), false, "removed container is dead (no such object)");

  process.env.FAKE_PODMAN_FAIL_INSPECT = "1";
  try {
    await assert.rejects(sandbox.isAlive(), SandboxDeadError);
  } finally {
    delete process.env.FAKE_PODMAN_FAIL_INSPECT;
  }
});

test("watchSandboxHealth detects and recreates a dead container without any exec", async (t) => {
  await setupFakePodman(t);
  const { sandbox, stateFile } = await makeSandbox(t);
  await sandbox.init();
  await killContainer(stateFile);

  const stop = watchSandboxHealth(sandbox, 25);
  try {
    // Poll until the recreation lands (bounded so a regression fails the test).
    for (let i = 0; i < 40 && sandbox.events.length === 0; i++) await sleep(25);
  } finally {
    stop();
  }
  assert.equal(sandbox.events.length, 1, "poll detected the dead container");
  assert.match(await state(stateFile), /^running$/, "container recreated by the poll");
});
