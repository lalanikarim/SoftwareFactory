// Phase 1 / Gate G1 — one real issue flows unattended to a draft PR.
//
//   node 02-orchestration-g1.mjs [--issue 3] [--request-id issue-3] [--timeout-min 25]
//
// Chain under test:
//   GitHub issue (fetched via gh api, delivered as a simulated webhook event)
//     -> intake adapter (POST /webhook/github)
//     -> factory POST /tasks {content, requestId}
//     -> orchestrator (delegate + open_draft_pr only)
//     -> sandboxed worker (Podman, node+git, network=none) on branch agent/issue-<n>
//     -> host-side push + DRAFT PR.
//
// G1 passes when a draft PR for head branch agent/issue-<n> exists with no
// human intervention between the simulated webhook delivery and PR creation.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIntakeServer } from "../factory/intake.ts";
import { spawnInstance, loadFactoryEnv, defaultConfigPath } from "./lib.ts";

const pExecFile = promisify(execFile);
async function sh(cmd, args, opts = {}) {
  const { stdout } = await pExecFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout.trim();
}

const argv = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};
const issueNumber = Number(opt("--issue", "3"));
const requestId = opt("--request-id", `issue-${issueNumber}`);
const timeoutMin = Number(opt("--timeout-min", "25"));

loadFactoryEnv(); // poc/.env (inference endpoint + fixtures repo)

// ---------------------------------------------------------------------------
// Preflight — fail fast with a clear message, no partial state.
// ---------------------------------------------------------------------------
console.log("preflight:");
let ok = true;
const check = (label, cond) => {
  console.log(`  ${cond ? "ok" : "FAIL"} - ${label}`);
  if (!cond) ok = false;
};

const endpointUrl = process.env.OPENAI_BASE_URL;
check("OPENAI_BASE_URL + OPENAI_API_KEY set", Boolean(endpointUrl && process.env.OPENAI_API_KEY));
let modelList = [];
if (endpointUrl && process.env.OPENAI_API_KEY) {
  try {
    const res = await fetch(`${endpointUrl.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    modelList = ((await res.json()).data ?? []).map((m) => m.id);
  } catch (e) {
    console.log(`  model endpoint error: ${e.message}`);
  }
}
check("model endpoint reachable with a loaded model", modelList.length > 0);

try {
  await sh("podman", ["image", "exists", "factory-sandbox:latest"]);
  check("factory-sandbox image present", true);
} catch {
  check("factory-sandbox image present (build: podman build -t factory-sandbox:latest poc-factory/sandbox-image/)", false);
}

let fixturesRepo = process.env.FIXTURES_REPO ?? "lalanikarim/factory-fixture";
let issue;
try {
  const out = await sh("gh", ["api", `repos/${fixturesRepo}/issues/${issueNumber}`, "--jq", ".title"]);
  issue = { title: out };
  check(`fixture issue #${issueNumber} readable: "${out}"`, true);
} catch (e) {
  check(`fixture issue #${issueNumber} readable (${e.message.split("\n")[0]})`, false);
}

// A clean G1 run needs no pre-existing draft PR/branch for this issue.
let preexisting = [];
try {
  const out = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", `agent/issue-${issueNumber}`, "--json", "number,url"]);
  preexisting = JSON.parse(out || "[]");
} catch { /* no PRs */ }
check(`no pre-existing open PR for agent/issue-${issueNumber}${preexisting.length ? ` (close ${preexisting.map((p) => "#" + p.number).join(", ")} first)` : ""}`, preexisting.length === 0);

if (!ok) {
  console.log("\nG1 ABORTED — fix preflight failures above.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Start factory + intake adapter, then deliver a simulated webhook event.
// ---------------------------------------------------------------------------
const t0 = Date.now();
const instance = await spawnInstance({ repo: fixturesRepo, configPath: defaultConfigPath(fixturesRepo) });
console.log(`factory on ${instance.base}`);

const { mkdtemp } = await import("node:fs/promises");
const g1tmp = await mkdtemp(join(tmpdir(), "g1-"));
const { server: intake, port: intakePort } = await startIntakeServer({
  logPath: join(g1tmp, "intake-g1-log.jsonl"),
  dispatch: async ({ requestId, content }) => {
    const res = await fetch(`${instance.base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.token}` },
      body: JSON.stringify({ requestId, content }),
    });
    if (!res.ok) throw new Error(`factory /tasks returned ${res.status}`);
    return res.json();
  },
});
console.log(`intake adapter on :${intakePort}`);

const event = {
  action: "opened",
  delivery_id: `g1-${Date.now()}`,
  repository: { full_name: fixturesRepo },
  issue: { number: issueNumber, title: issue.title, body: (await sh("gh", ["api", `repos/${fixturesRepo}/issues/${issueNumber}`, "--jq", ".body // \"\""])).trim(), labels: [{ name: "agent" }] },
};
const delivery = await fetch(`http://127.0.0.1:${intakePort}/webhook/github`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": event.delivery_id },
  body: JSON.stringify(event),
});
const deliveryBody = await delivery.json();
console.log(`webhook delivered: status=${delivery.status} accepted=${deliveryBody.accepted} requestId=${deliveryBody.requestId}`);
if (!deliveryBody.accepted) {
  console.log("\nG1 FAIL — intake rejected the event.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Poll for the draft PR (objective: no model judgment).
// ---------------------------------------------------------------------------
const deadline = Date.now() + timeoutMin * 60_000;
let pr = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000));
  try {
    const out = await sh("gh", ["pr", "list", "--repo", fixturesRepo, "--state", "open", "--head", `agent/issue-${issueNumber}`, "--json", "number,url,isDraft,headRefName"]);
    const list = JSON.parse(out || "[]");
    if (list.length > 0) {
      pr = list[0];
      break;
    }
  } catch { /* not yet */ }
  process.stdout.write(".");
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

let pass = false;
if (pr && pr.isDraft && pr.headRefName === `agent/issue-${issueNumber}`) {
  pass = true;
  console.log(`\nG1 PASS — draft PR ${pr.url} (head ${pr.headRefName}) in ${secs}s`);
} else {
  console.log(`\nG1 FAIL — no draft PR for agent/issue-${issueNumber} after ${secs}s${pr ? ` (found non-draft: ${pr.url})` : ""}`);
}

intake.close();
await instance.close();
process.exitCode = pass ? 0 : 1;
