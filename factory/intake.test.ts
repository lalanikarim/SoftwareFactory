// Unit tests for the TS intake port: signature verification, cross-repo
// rejection (gate M3), sender allowlist, and event filtering. No model calls.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { startIntakeServer, verifyGitHubSignature, isAgentIssueEvent } from "./intake.ts";

const SECRET = "test-webhook-secret";

function sign(body: Buffer): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

const issueEvent = (repo: string, opts: { action?: string; labels?: string[]; sender?: string } = {}) => ({
  action: opts.action ?? "opened",
  repository: { full_name: repo },
  issue: { number: 42, title: "Test issue", body: "do the thing", labels: (opts.labels ?? ["agent"]).map((name) => ({ name })) },
  ...(opts.sender ? { sender: { login: opts.sender } } : {}),
});

// --- verifyGitHubSignature -------------------------------------------------
{
  const body = Buffer.from('{"x":1}');
  assert.equal(verifyGitHubSignature({ signatureHeader: sign(body), rawBody: body, secret: SECRET }), true, "valid signature");
  assert.equal(verifyGitHubSignature({ signatureHeader: sign(Buffer.from('{"x":2}')), rawBody: body, secret: SECRET }), false, "wrong body digest");
  assert.equal(verifyGitHubSignature({ signatureHeader: undefined, rawBody: body, secret: SECRET }), false, "missing header");
  assert.equal(verifyGitHubSignature({ signatureHeader: sign(body), rawBody: body, secret: "" }), false, "empty secret fails closed");
}

// --- isAgentIssueEvent -----------------------------------------------------
{
  assert.equal(isAgentIssueEvent(issueEvent("o/r")), true, "opened with agent label");
  assert.equal(isAgentIssueEvent(issueEvent("o/r", { labels: ["other"] })), false, "opened without agent label");
  assert.equal(isAgentIssueEvent({ action: "labeled", label: { name: "agent" }, issue: { number: 1 } }), true, "labeled agent");
  assert.equal(isAgentIssueEvent({ action: "edited", issue: { number: 1 } }), false, "edited is ignored");
  assert.equal(isAgentIssueEvent(null), false, "null event");
}

// --- server: routes mode ---------------------------------------------------
{
  const dispatched: Array<{ repo: string; n: number }> = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [
      { repo: "alpha/one", secret: SECRET, target: "http://127.0.0.1:1/tasks", token: "t" },
      { repo: "beta/two", secret: "other-secret", target: "http://127.0.0.1:2/tasks", token: "t" },
    ],
    dispatch: async (repo: string, event: any) => { dispatched.push({ repo, n: event.issue.number }); return { submissionId: 1 }; },
  });

  const post = (event: unknown, secret: string) => {
    const body = Buffer.from(JSON.stringify(event));
    return fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body: body.toString(),
    });
  };

  // Happy path: signed with alpha's secret, names alpha/one -> dispatched.
  let res = await post(issueEvent("alpha/one"), SECRET);
  assert.equal(res.status, 202, `expected 202, got ${res.status}: ${await res.text()}`);
  assert.deepEqual(dispatched, [{ repo: "alpha/one", n: 42 }], "dispatched to owning route");

  // Cross-repo naming (M3): signed with alpha's secret but names beta/two.
  res = await post(issueEvent("beta/two"), SECRET);
  assert.equal(res.status, 403, `expected 403 cross-repo, got ${res.status}`);

  // Wrong secret: signed with beta's secret naming alpha/one.
  res = await post(issueEvent("alpha/one"), "other-secret");
  assert.equal(res.status, 403, `expected 403 wrong-secret-naming, got ${res.status}`);

  // Non-agent event: valid signature but no agent label -> 200 not accepted.
  res = await post(issueEvent("alpha/one", { labels: ["other"] }), SECRET);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.accepted, false);

  server.close();
}

// --- server: sender allowlist ----------------------------------------------
{
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [{ repo: "alpha/one", secret: SECRET, target: "http://x/tasks", token: "t", allowedSenders: ["alice"] }],
    dispatch: async () => ({ submissionId: 1 }),
  });
  const body = Buffer.from(JSON.stringify(issueEvent("alpha/one", { sender: "mallory" })));
  const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body: body.toString(),
  });
  assert.equal(res.status, 403, `expected 403 sender not allowlisted, got ${res.status}`);
  server.close();
}

// --- server: non-loopback requires auth ------------------------------------
{
  assert.throws(
    () => startIntakeServer({ port: 0, host: "0.0.0.0", dispatch: async () => ({}) }),
    /refusing to bind/,
    "non-loopback without secret must refuse to start",
  );
}

console.log("intake (TS port): all checks passed");
