// #69: the adapter must never serve on stale policy. The supervisor writes the routes file before
// spawning anything (atomically), and the adapter re-hashes it on every webhook request; a changed
// file means refuse with 503 and exit, so the supervisor restarts against current policy.
//
//   node --experimental-strip-types --test test/routes-drift.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routesFileHash, makeRoutesDriftCheck } from "../factory/adapter.ts";
import { RoutesDriftedError, startIntakeServer } from "../factory/intake.ts";
import { writeRoutesFile } from "../fleet/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "routes-drift-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ROUTES_FILE = join(dir, "routes.json");
const initialRoutes = [{ repo: "octo/one", secret: "s1" }, { repo: "octo/two", secret: "s2" }];
writeFileSync(ROUTES_FILE, JSON.stringify(initialRoutes, null, 2));

// --- writeRoutesFile --------------------------------------------------------
test("writeRoutesFile writes valid JSON and returns the sha256 of exactly what it wrote", () => {
  const hash = writeRoutesFile(join(dir, "fresh.json"), [{ repo: "octo/x", secret: "s" }]);
  const onDisk = readFileSync(join(dir, "fresh.json"), "utf8");
  assert.equal(routesFileHash(join(dir, "fresh.json")), hash);
  JSON.parse(onDisk); // a reader must always see complete policy, never a partial document
});

test("writeRoutesFile overwrites in place and leaves no temp files behind", () => {
  const target = join(dir, "over.json");
  writeFileSync(target, "[{\"repo\":\"stale/old\",\"secret\":\"x\"}]");
  writeRoutesFile(target, [{ repo: "octo/new", secret: "y" }]);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), [{ repo: "octo/new", secret: "y" }]);
  const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp-"));
  assert.equal(leftovers.length, 0, `temp files left behind: ${leftovers.join(", ")}`);
});

// --- makeRoutesDriftCheck ---------------------------------------------------
test("no change to the routes file passes the check", () => {
  const startup = routesFileHash(ROUTES_FILE);
  const terminateCalls = [];
  const check = makeRoutesDriftCheck({ routesFile: ROUTES_FILE, startupHash: startup, terminate: () => terminateCalls.push(1) });
  assert.doesNotThrow(check);
  assert.equal(terminateCalls.length, 0);
});

test("a changed routes file throws RoutesDriftedError and schedules termination", () => {
  const startup = routesFileHash(ROUTES_FILE);
  writeFileSync(ROUTES_FILE, JSON.stringify([...initialRoutes, { repo: "octo/three", secret: "s3" }], null, 2));
  const terminateCalls = [];
  const check = makeRoutesDriftCheck({ routesFile: ROUTES_FILE, startupHash: startup, terminate: () => terminateCalls.push(1) });
  assert.throws(check, RoutesDriftedError);
  assert.equal(terminateCalls.length, 1, "drift must schedule exactly one termination");
});

test("a missing routes file is drift too — the policy behind the adapter is gone", () => {
  const startup = "0".repeat(64);
  rmSync(join(dir, "gone.json"), { force: true });
  const terminateCalls = [];
  const check = makeRoutesDriftCheck({ routesFile: join(dir, "gone.json"), startupHash: startup, terminate: () => terminateCalls.push(1) });
  assert.throws(check, RoutesDriftedError);
  assert.equal(terminateCalls.length, 1);
});

// --- intake server honors the drift check ------------------------------------
test("a webhook request during drift is refused with 503 and never dispatched", async () => {
  const startup = routesFileHash(ROUTES_FILE);
  writeFileSync(ROUTES_FILE, JSON.stringify(initialRoutes.slice(0, 1), null, 2)); // policy shrank out from under us
  const dispatched = [];
  const terminated = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: initialRoutes, // the snapshot the adapter started with
    dispatch: async (repo) => { dispatched.push(repo); return {}; },
    routesDriftCheck: makeRoutesDriftCheck({ routesFile: ROUTES_FILE, startupHash: startup, terminate: () => terminated.push(1) }),
  });
  try {
    const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "octo/one" }, issue: { number: 7, title: "t", body: "b", labels: [{ name: "agent" }] } }));
    const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": `sha256=${createHmac("sha256", "s1").update(body).digest("hex")}` },
      body,
    });
    assert.equal(res.status, 503);
    const payload = await res.json();
    assert.match(payload.error, /routes file changed since adapter start/);
    assert.equal(dispatched.length, 0, "a stale route set must never reach dispatch");
    assert.equal(terminated.length, 1, "the checker scheduled termination for the supervisor to act on");
  } finally {
    server.close();
  }
});

test("with an unchanged routes file the same request flows through normally", async () => {
  const startup = routesFileHash(ROUTES_FILE); // hash of whatever is on disk now; no further changes
  const dispatched = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: initialRoutes.slice(0, 1),
    dispatch: async (repo) => { dispatched.push(repo); return {}; },
    routesDriftCheck: makeRoutesDriftCheck({ routesFile: ROUTES_FILE, startupHash: startup }),
  });
  try {
    const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "octo/one" }, issue: { number: 8, title: "t", body: "b", labels: [{ name: "agent" }] } }));
    const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": `sha256=${createHmac("sha256", "s1").update(body).digest("hex")}` },
      body,
    });
    assert.equal(res.status, 202);
    assert.deepEqual(dispatched, ["octo/one"]);
  } finally {
    server.close();
  }
});
