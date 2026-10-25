// Fleet supervisor (multi-repo plan §3.3).
//
// One factory process per managed repo + one adapter, started from a single
// fleet file; restart-on-fault (the durable harness recovers in-process
// state from its sqlite db, so a plain respawn is safe — crash-durability is
// the PoC's core property). On Linux hosts this can be replaced by systemd
// units with the same one-unit-per-factory shape.
//
// Fleet file (JSON):
// {
//   "adapter":  { "port": 9700, "routesFile": "data/routes.json", "logPath": "data/intake-adapter.jsonl" },
//   "factories": [
//     { "repo": "owner/name", "config": "config/owner-name.json", "port": 9601, "db": "data/factories/owner-name.sqlite" }
//   ]
// }
//
// Usage:
//   node supervise.mjs run <fleet.json>       # start everything; restart on fault
//   node supervise.mjs status <fleet.json>    # read-only fan-out status table

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_RESTARTS = 10;
const RESTART_BACKOFF_MS = 5000;

function loadFleet(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read/parse fleet file ${path}: ${e.message}`);
  }
  if (!Array.isArray(raw.factories) || !raw.factories.length) throw new Error("fleet.factories must be a non-empty array");
  for (const f of raw.factories) {
    for (const key of ["repo", "config", "port", "db"]) {
      if (f[key] === undefined) throw new Error(`factory entry missing "${key}": ${JSON.stringify(f)}`);
    }
  }
  return raw;
}

function spawnProc(name, args, logPrefix) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const pump = (stream, prefix) => stream.on("data", (d) => process.stdout.write(`[${logPrefix}] ${prefix}${String(d).replace(/\n$/, "")}\n`));
  pump(child.stdout, "");
  pump(child.stderr, "err: ");
  return child;
}

async function runFleet(fleetPath) {
  const fleet = loadFleet(fleetPath);
  let shuttingDown = false;
  const restarts = new Map();
  const children = [];

  const startFactory = (f) => {
    const key = `factory:${f.repo}`;
    restarts.set(key, (restarts.get(key) ?? 0) + 1);
    if (restarts.get(key) > MAX_RESTARTS) {
      console.error(`[supervisor] ${key} exceeded ${MAX_RESTARTS} restarts — giving up`);
      shuttingDown = true;
      return;
    }
    const args = [join(__dirname, "lib/factory.mjs"), String(f.port), f.db, f.config];
    console.log(`[supervisor] starting ${key} (port ${f.port}) — attempt ${restarts.get(key)}`);
    const child = spawnProc(key, args, f.repo);
    children.push(child);
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`[supervisor] ${key} exited (${signal ?? `code ${code}`}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`);
      setTimeout(() => startFactory(f), RESTART_BACKOFF_MS);
    });
  };

  const startAdapter = () => {
    const a = fleet.adapter;
    if (!a) return; // adapter is optional (single-factory dev mode)
    const key = "adapter";
    restarts.set(key, (restarts.get(key) ?? 0) + 1);
    if (restarts.get(key) > MAX_RESTARTS) {
      console.error(`[supervisor] ${key} exceeded ${MAX_RESTARTS} restarts — giving up`);
      shuttingDown = true;
      return;
    }
    const args = [join(__dirname, "lib/adapter.mjs"), String(a.port), a.routesFile, a.logPath ?? "data/intake-adapter.jsonl"];
    console.log(`[supervisor] starting ${key} (port ${a.port}) — attempt ${restarts.get(key)}`);
    const child = spawnProc(key, args, "adapter");
    children.push(child);
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`[supervisor] ${key} exited (${signal ?? `code ${code}`}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`);
      setTimeout(startAdapter, RESTART_BACKOFF_MS);
    });
  };

  for (const f of fleet.factories) startFactory(f);
  startAdapter();

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[supervisor] shutting down");
    for (const c of children) c.kill("SIGTERM");
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function statusFleet(fleetPath) {
  const fleet = loadFleet(fleetPath);
  const rows = [];
  await Promise.all(fleet.factories.map(async (f) => {
    const base = `http://127.0.0.1:${f.port}`;
    const row = { repo: f.repo, port: f.port, state: "DOWN", pending: "", lastTool: "" };
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      if (!health.ok) throw new Error(`health ${health.status}`);
      row.state = "up";
      const [approvals, toolResults] = await Promise.all([
        fetch(`${base}/approvals`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
        fetch(`${base}/tool-results?n=3`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      ]);
      const pending = approvals.approvals ?? [];
      if (pending.length) {
        row.state = "awaiting approval";
        row.pending = pending.map((a) => a.key ?? "?").join(",");
      } else {
        row.state = "idle/working";
      }
      const last = (toolResults.results ?? [])[0];
      if (last) row.lastTool = `${last.toolName}${last.isError ? " (error)" : ""}`;
    } catch { /* stays DOWN */ }
    rows.push(row);
  }));

  const width = Math.max(...rows.map((r) => r.repo.length), 4);
  console.log("repo".padEnd(width), "| port  | state              | pending approvals | last tool");
  for (const r of rows) {
    console.log(r.repo.padEnd(width), `| ${String(r.port).padEnd(5)} | ${r.state.padEnd(18)} | ${r.pending.padEnd(19)} | ${r.lastTool}`);
  }
  if (fleet.adapter) {
    const a = fleet.adapter;
    try {
      const res = await fetch(`http://127.0.0.1:${a.port}/health`, { signal: AbortSignal.timeout(3000) });
      const body = res.ok ? await res.json() : {};
      console.log(`adapter on port ${a.port}: ${res.ok ? `up (routes: ${(body.routes ?? []).join(", ")})` : `down (${res.status})`}`);
    } catch {
      console.log(`adapter on port ${a.port}: down`);
    }
  }
}

const [,, command, fleetPath] = process.argv;
if (!command || !fleetPath) {
  console.error("usage: node supervise.mjs <run|status> <fleet.json>");
  process.exit(1);
}
try {
  if (command === "run") await runFleet(fleetPath);
  else if (command === "status") await statusFleet(fleetPath);
  else { console.error(`unknown command ${command}`); process.exit(1); }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
