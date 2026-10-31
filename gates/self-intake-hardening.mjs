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
import net from "node:net";
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
// These two checks drive a RAW socket on purpose. The first version of them used fetch() with a full
// 3 MB body and asserted `res.status === 413` — which cannot work against a server that behaves the way
// the criteria ask it to: refusing early means tearing the connection down mid-upload, and undici reports
// that as "fetch failed" instead of surfacing the status. In other words the oracle contradicted its own
// requirement ("stopping the connection early is preferred over reading-then-refusing") and would have
// punished the better implementation. The raw form is also a STRONGER claim than the one it replaces:
// the client never sends the payload, so a 413 can only arrive if refusal happened before buffering.
function rawExchange(port, { headers, onConnect, timeoutMs = 8000 }) {
  return new Promise((resolveExchange) => {
    const sock = net.connect(port, "127.0.0.1");
    let got = "";
    let settled = false;
    let closed = false;
    const statusOf = () => (got.match(/HTTP\/1\.[01] (\d{3})/) ?? [])[1];
    const done = (r) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolveExchange(r);
    };
    // A server that refuses early tears the connection down while we are still writing, so "error" and
    // "data" race. Never let an EPIPE win over a status line that already arrived — that would make the
    // oracle fail on the behavior it is asking for.
    const settleIfAnswered = () => {
      const s = statusOf();
      if (s) done({ status: Number(s), raw: got });
      return Boolean(s);
    };
    sock.on("data", (d) => {
      got += d.toString("latin1");
      settleIfAnswered();
    });
    const lament = (why) => setTimeout(() => (settleIfAnswered() ? undefined : done({ error: why, raw: got.slice(0, 200) })), 150);
    sock.on("error", (e) => {
      closed = true;
      lament(`socket error: ${e.message}`);
    });
    sock.on("close", () => {
      closed = true;
      lament("connection closed");
    });
    sock.on("connect", () => {
      sock.write(`POST /webhook/github HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}`);
      onConnect(sock, () => closed);
    });
    setTimeout(() => (settleIfAnswered() ? undefined : done({ error: `no response within ${timeoutMs}ms`, raw: got.slice(0, 200) })), timeoutMs);
  });
}

await check("over-cap Content-Length is refused with 413 before any payload is sent", async () => {
  const before = dispatched.length;
  // Announce 3 MB, send 5 bytes. A server that buffers-then-checks has nothing to answer yet.
  const r = await rawExchange(srv.port, {
    headers: "content-type: application/json\r\ncontent-length: 3000000\r\nx-hub-signature-256: sha256=deadbeef\r\n\r\n",
    onConnect: (sock) => sock.write('{"a":'),
  });
  assert.equal(r.status, 413, `expected 413 before the body arrives, got ${JSON.stringify(r).slice(0, 200)}`);
  assert.equal(dispatched.length, before, "a refused body must never be dispatched");
});

// What this check does and does not require, because it was wrong in its first draft: it used to demand
// an observable `413` status line on the chunked path. A correct implementation may answer and then tear
// the connection down while the client is still writing, and Node can reset the socket before the last
// response byte lands — so demanding a visible status there penalized exactly the early-refusal behavior
// the criteria asked for. What actually matters is that the server STOPS THE CALLER before it has finished
// sending (that is what "not buffered" means from outside), that nothing is dispatched, and that a status
// line, if the client is lucky enough to receive one, says 413. The declared-Content-Length check above
// keeps the stronger requirement, because there the response always arrives.
await check("a streamed body with no Content-Length is cut off before it finishes sending", async () => {
  // The harder path: chunked encoding hides the size, so a cap that only reads Content-Length passes
  // the check above and still buffers an attacker's stream. Write 64 KB frames until the server answers.
  const before = dispatched.length;
  let written = 0;
  const r = await rawExchange(srv.port, {
    headers: "content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n",
    onConnect: (sock, isClosed) => {
      const frame = Buffer.alloc(32 * 1024, 0x61);
      const pump = () => {
        // Stop politely once the server has hung up; the exchange resolves from the response side.
        if (isClosed() || written > 8 * 1024 * 1024) return;
        sock.write(`${frame.length.toString(16)}\r\n`, () => {});
        sock.write(frame, () => {});
        sock.write("\r\n", () => {
          written += frame.length;
          if (!isClosed()) setImmediate(pump);
        });
      };
      pump();
    },
  });
  const cutOffEarly = written < 2 * 1024 * 1024;
  assert.ok(
    cutOffEarly,
    `the server let ${Math.round(written / 1024)} KB arrive without refusing it — that is buffering, not capping`,
  );
  if (r.status !== undefined) {
    assert.equal(r.status, 413, `a status line on an over-cap stream must be 413, got ${r.status}`);
  }
  assert.equal(dispatched.length, before, "a cut-off stream must never be dispatched");
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
