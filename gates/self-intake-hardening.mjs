#!/usr/bin/env node
// Verification oracle for drydock self-work task: "make the intake listener safe to expose".
//
// Why this is a standalone script and not a gates/probes/ module: the probe contract boots a repo's
// HTTP app via the registry's `oracleBoot` recipe, which assumes the graded repo IS a service with a
// port. Drydock isn't — the thing under test here is one module inside it, so this oracle imports that
// module from the workspace and drives it directly. Same principle though: the assertions were written
// from the acceptance criteria below, they live OUTSIDE drydock's worker allowlist (`gates/` is excluded
// in factory/repo-registry.json), and they are deliberately failing on `main` today — a fix that does
// not turn them green did not fix the thing.
//
// Acceptance criteria (from the task text, not from any implementation):
//   1. An unauthenticated GET /health must not disclose which repositories the adapter is configured
//      for. Funnel publishes this port to the public internet; "which private repos exist" is not
//      something to answer for a stranger. Implementation choice is open (drop the field, gate the
//      endpoint, return only {status}) — the observable requirement is: no repo names without creds.
//   2. A request body larger than a documented cap must be refused with 413 BEFORE it is buffered or
//      parsed. Today every byte of any POST to that path accumulates in memory before the signature is
//      even looked at, so an anonymous attacker's memory cost becomes our listener's memory cost.
//   3. Everything that works today keeps working: valid signature + eligible label -> accepted;
//      bad signature -> refused without dispatching. A "fix" that breaks intake is not a fix.
//
// Usage: node --experimental-strip-types gates/self-intake-hardening.mjs [workspaceDir]

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const WS = resolve(process.argv[2] ?? ".");
const SECRET = "oracle-secret";
const ALPHA = "selftest/alpha";
const results = [];
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(
      () => void results.push({ name, ok: true }),
      (e) => void results.push({ name, ok: false, err: String(e?.message ?? e).slice(0, 400) }),
    );

const { startIntakeServer } = await import(pathToFileURL(resolve(WS, "factory/intake.ts")).href);

const dispatched = [];
const srv = await startIntakeServer({
  port: 0,
  host: "127.0.0.1",
  routes: [{ repo: ALPHA, secret: SECRET, target: "http://127.0.0.1:1/tasks", token: "t", eligibilityLabel: "agent" }],
  dispatch: async (repo) => {
    dispatched.push(repo);
    return { submissionId: 1 };
  },
});
const base = `http://127.0.0.1:${srv.port}`;

const postRaw = (body, headers = {}) => fetch(`${base}/webhook/github`, { method: "POST", headers, body });

// --- 1. /health must not name repositories to anonymous callers -----------------------------------
await check("GET /health does not disclose configured repository names", async () => {
  const res = await fetch(`${base}/health`);
  assert.ok(res.ok, `/health responded ${res.status}`);
  const body = await res.text();
  assert.ok(
    !body.includes(ALPHA),
    `/health disclosed a repository name to an unauthenticated caller: ${body.slice(0, 200)}`,
  );
});

await check("GET /health still reports liveness", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200, "liveness must stay unauthenticated so a supervisor/healthcheck can poll it");
  const body = await res.text();
  assert.match(body.toLowerCase(), /ok|alive|healthy|up/, `liveness payload unclear: ${body.slice(0, 200)}`);
});

// --- 2. oversized bodies refused before buffering ---------------------------------------------------
await check("oversized POST is refused with 413 (not buffered and parsed)", async () => {
  // 3 MB of JSON-ish bytes. Today this is accumulated in full before the signature header is read.
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61); // 'a' — invalid JSON on purpose
  const res = await postRaw(big, { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" });
  assert.equal(res.status, 413, `expected 413 for an oversized body, got ${res.status}`);
});

await check("oversized POST never reaches dispatch", async () => {
  const before = dispatched.length;
  await postRaw(Buffer.alloc(3 * 1024 * 1024, 0x7b), { "content-type": "application/json" });
  assert.equal(dispatched.length, before, "an oversized body must not be dispatched");
});

// --- 3. the working path stays working --------------------------------------------------------------
const signedEvent = () => {
  const body = Buffer.from(
    JSON.stringify({
      action: "labeled",
      label: { name: "agent" },
      repository: { full_name: ALPHA },
      issue: { number: 77, title: "t", body: "b", labels: [{ name: "agent" }] },
      sender: { login: "someone" },
    }),
  );
  return { body, sig: `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}` };
};

await check("a body comfortably under the cap still dispatches", async () => {
  const { body, sig } = signedEvent();
  const res = await postRaw(body.toString(), { "content-type": "application/json", "x-hub-signature-256": sig });
  assert.equal(res.status, 202, `expected 202, got ${res.status}: ${(await res.text()).slice(0, 200)}`);
  assert.deepEqual(dispatched, [ALPHA]);
});

await check("a bad signature is still refused without dispatch", async () => {
  const { body } = signedEvent();
  const before = dispatched.length;
  const res = await postRaw(body.toString(), { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  assert.equal(dispatched.length, before);
});

srv.server.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.err ? `\n     ${r.err}` : ""}`);
console.log(`\nintake hardening oracle: ${results.length - failed.length}/${results.length} checks pass`);
process.exitCode = failed.length ? 1 : 0;
