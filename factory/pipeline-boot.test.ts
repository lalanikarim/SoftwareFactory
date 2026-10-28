// Phase 1 boot test: the full factory pipeline composed on createCoreInstance.
// Hermetic — temp dirs under os.tmpdir(), ephemeral port, no podman (no
// sandboxed conversations are started), no GitHub calls. Skips cleanly when
// the inference endpoint from .env is unreachable (same as core-spike).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Kernel's declared public surface (app/src/core.ts), not internal modules.
import { createCoreInstance, loadConfig } from "../vendor/engram/app/src/core.ts";
import { instanceGatesConfig } from "./gate-policy.ts";

async function firstModelRef(base: string): Promise<{ provider: string; modelId: string }> {
  const r = await fetch(`${base.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
    signal: AbortSignal.timeout(5000),
  });
  const j = (await r.json()) as { data?: Array<{ id: string }> };
  const id = j.data?.[0]?.id;
  if (!id) throw new Error("no models reported by /models");
  return { provider: "openai-completions", modelId: id };
}
import { factoryPipeline, ORCHESTRATOR_INSTRUCTIONS } from "./pipeline.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadFactoryEnv() {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] ??= v;
  }
}

async function reachable(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

loadFactoryEnv();
process.env.API_TOKEN ??= "drydock-factory-boot-token";
const baseUrl = process.env.OPENAI_BASE_URL ?? "";
const apiKey = process.env.API_TOKEN ?? "";
if (!baseUrl || !apiKey) {
  console.log("core boot (factory pipeline): SKIP — no inference endpoint in .env");
  process.exit(0);
}
if (!(await reachable(baseUrl))) {
  console.log(`core boot (factory pipeline): SKIP — ${baseUrl} not reachable`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "drydock-factory-boot-"));
const dataDir = join(tmp, "engram-data");
const configDir = join(tmp, "config");
const workRoot = join(tmp, "work");
for (const d of [dataDir, configDir, workRoot]) mkdirSync(d, { recursive: true });

// Factory-owned gate policy — the SAME object production writes (factory/gate-policy.ts). This
// used to be a hand-copied duplicate that had drifted: it carried a destructivePattern matching
// {"issueNumber":N}, which also matches delegate()'s arg shape. Shared module + pin test instead.
writeFileSync(join(configDir, "gates.json"), JSON.stringify(instanceGatesConfig(), null, 2));

const config = loadConfig({
  dataDir,
  configDir,
  workRoot,
  sandbox: { image: "factory-sandbox:latest", network: "none", allowImages: ["factory-sandbox:latest"], allowMountRoot: workRoot },
});

const auth = { authorization: `Bearer ${process.env.API_TOKEN ?? ""}` };

const modelRef = await firstModelRef(baseUrl);

const ext = factoryPipeline({
  workDir: workRoot,
  fixturesRepo: "lalanikarim/factory-fixture",
  modelRef,
});
const rootTools = (ext.tools ?? []).filter((t) => ["delegate", "open_draft_pr", "merge_pr", "note_lesson"].includes(t.name));

const instance = await createCoreInstance({
  config,
  extraExtensions: [ext],
  port: 0,
  rootAgent: { instructions: ORCHESTRATOR_INSTRUCTIONS, tools: rootTools },
});

try {
  const base = `http://127.0.0.1:${instance.actualPort}`;
  const health = await (await fetch(`${base}/health`, { headers: auth })).json();
  assert.equal(health.status, "ok", "health");
  console.log("check: /health ok on ephemeral port");

  // The root conversation exists and the server lists it.
  const convList = await (await fetch(`${base}/conversations`, { headers: auth })).json();
  assert.ok(Array.isArray(convList.conversations), "conversation list");
  console.log(`check: root conversation listed (${convList.conversations.length} conversation(s))`);

  // The core /tasks API accepts a submission against the factory instance.
  const tasksRes = await fetch(`${base}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ content: "Reply with exactly: ok", requestId: "boot-check" }),
  });
  assert.equal(tasksRes.status, 202, `expected 202, got ${tasksRes.status}`);
  const sub = await tasksRes.json();
  assert.ok(sub.submissionId, "submissionId");
  console.log("check: /api/tasks accepted a submission (root agent live with factory tools)");

  // Idempotent close + port release.
  await instance.close();
  await instance.close();
  const healthAfter = await fetch(`${base}/health`, { headers: auth }).then(() => "up").catch(() => "down");
  assert.equal(healthAfter, "down", "server down after close");
  console.log("check: idempotent close; port released");
} finally {
  try { await instance.close(); } catch { /* already closed */ }
}

console.log("core boot (factory pipeline): all checks passed");
