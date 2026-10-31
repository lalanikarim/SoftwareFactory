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

  // Per-repo eligibility labels (the registry's `eligibilityLabel`, §5.11). drydock self-work uses
  // "build"; without threading this the label was hardcoded and such an issue could never trigger work.
  assert.equal(isAgentIssueEvent(issueEvent("o/r", { labels: ["build"] }), "build"), true, "opened with the repo's own label");
  assert.equal(isAgentIssueEvent(issueEvent("o/r", { labels: ["agent"] }), "build"), false, "a different repo's trigger label must not fire here");
  assert.equal(isAgentIssueEvent({ action: "labeled", label: { name: "build" }, issue: { number: 2 } }, "build"), true, "labeled with the repo's own label");
  assert.equal(isAgentIssueEvent({ action: "labeled", label: { name: "agent" }, issue: { number: 2 } }), true, "absent argument keeps the historical default");
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

// --- server: per-route eligibility labels ----------------------------------
{
  const dispatched: string[] = [];
  const { server, port } = await startIntakeServer({
    port: 0,
    host: "127.0.0.1",
    routes: [
      { repo: "alpha/one", secret: SECRET, target: "http://x/tasks", token: "t" },
      { repo: "build/two", secret: "build-secret", target: "http://y/tasks", token: "t", eligibilityLabel: "build" },
    ],
    dispatch: async (repo: string) => { dispatched.push(repo); return { submissionId: 1 }; },
  });
  const post = (event: unknown, secret: string) => {
    const body = Buffer.from(JSON.stringify(event));
    return fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
      body: body.toString(),
    });
  };

  // The build-labelled issue on the route declaring eligibilityLabel "build" is accepted…
  let res = await post(issueEvent("build/two", { labels: ["build"] }), "build-secret");
  assert.equal(res.status, 202, `expected 202 for repo-specific label, got ${res.status}: ${await res.text()}`);

  // …and an "agent"-labelled issue on that same route is NOT: labels are per repo, not global.
  res = await post(issueEvent("build/two", { labels: ["agent"] }), "build-secret");
  assert.equal(res.status, 200, "wrong label for this route must be ignored, not dispatched");
  assert.equal((await res.json()).accepted, false);

  // A route with no eligibilityLabel keeps defaulting to "agent" (fixtures unchanged).
  res = await post(issueEvent("alpha/one", { labels: ["agent"] }), SECRET);
  assert.equal(res.status, 202, "default label must stay 'agent'");
  assert.deepEqual(dispatched, ["build/two", "alpha/one"]);

  server.close();
}

// --- validateRoutes rejects a blank eligibility label ----------------------
{
  const { validateRoutes } = await import("./intake.ts");
  assert.throws(() => validateRoutes([{ repo: "a/b", secret: "s", eligibilityLabel: "  " }]), /eligibilityLabel must be a non-empty string/);
  assert.throws(() => validateRoutes([{ repo: "a/b", secret: "s", eligibilityLabel: 42 } as any]), /eligibilityLabel must be a non-empty string/);
  validateRoutes([{ repo: "a/b", secret: "s", eligibilityLabel: "build" }]);
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
