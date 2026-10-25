// Multi-repo webhook adapter (multi-repo plan §3.2).
//
// One reachable intake endpoint in front of N factories. Each managed repo's
// GitHub webhook points here with its OWN secret; the raw body's HMAC is
// verified against every configured secret BEFORE parsing, and the matching
// secret determines which factory's /tasks receives the event. A payload
// that names a different repo than the one whose secret signed it is
// rejected 403 (gate M3).
//
// Routes file: JSON array of { repo, secret, target } where target is the
// owning factory's base URL (e.g. "http://127.0.0.1:9601").
//
// Standalone: node lib/adapter.mjs [port] <routesFile> [logPath]

import { startIntakeServer, loadRoutes, intakeRequestId, renderIntakeContent } from "./intake.mjs";

/** Build a dispatch(repo, event) that forwards to the owning factory's /tasks. */
export function makeRouteDispatch(routes) {
  const targetByRepo = new Map(routes.map((r) => [r.repo, r.target ?? null]));
  return async (repo, event) => {
    const target = targetByRepo.get(repo);
    if (!target) throw new Error(`no /tasks target configured for ${repo}`);
    const body = JSON.stringify({ requestId: intakeRequestId(event), content: renderIntakeContent(event) });
    const res = await fetch(`${target.replace(/\/$/, "")}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`factory for ${repo} rejected task (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
}

// Standalone.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = process.argv[2] ? Number(process.argv[2]) : 9700;
  const routesFile = process.argv[3];
  if (!routesFile) {
    console.error("usage: node lib/adapter.mjs [port] <routesFile> [logPath]");
    process.exit(1);
  }
  const routes = loadRoutes(routesFile);
  const logPath = process.argv[4] ?? "data/intake-adapter.jsonl";
  const { server, port: actualPort, host } = await startIntakeServer({
    port,
    host: process.env.ADAPTER_HOST ?? "127.0.0.1", // reachable only behind a TLS proxy with ADAPTER_HOST set
    routes,
    dispatch: makeRouteDispatch(routes),
    logPath,
  });
  console.log(`adapter listening on http://${host}:${actualPort} (routes: ${routes.map((r) => r.repo).join(", ")})`);

  const shutdown = async () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
