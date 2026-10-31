// Multi-repo webhook adapter (multi-repo plan §3.2), ported to TS.
//
// One reachable intake endpoint in front of N factory instances. Each managed
// repo's GitHub webhook points here with its OWN secret; the raw body's HMAC
// is verified against every configured secret BEFORE parsing, and the matching
// secret determines which instance's /tasks receives the event. A payload that
// names a different repo than the one whose secret signed it is rejected 403
// (gate M3).
//
// Routes file: JSON array of { repo, secret, target, token } where target is
// the owning instance's base URL (e.g. "http://127.0.0.1:9601") and token is
// that instance's API_TOKEN (the core server requires Bearer auth on /tasks).
//
// Standalone: node --experimental-strip-types factory/adapter.ts [port] <routesFile> [logPath]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { startIntakeServer, loadRoutes, intakeRequestId, renderIntakeContent, RoutesDriftedError, type Route } from "./intake.ts";

/**
 * sha256 of a routes file. The supervisor and the adapter both report this hash in their startup
 * logs, so a drift event is diagnosable from logs alone: which write does the running adapter not
 * match? (#69)
 */
export function routesFileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Per-request drift check for a routes file (decision C3, #69): the adapter validates signatures and
 * routes against the snapshot it loaded at start; if the file on disk no longer hashes to that
 * snapshot, serving on old authority is wrong — refuse the request (the caller gets 503) and stop,
 * so the supervisor can restart us against the new policy. No silent reload: a policy change taking
 * effect without an explicit process boundary would break "policy reviews like code".
 *
 * `terminate` is injectable so tests can observe the exit instead of dying; the default exits after a
 * short delay so the 503 response has a chance to flush first.
 */
export function makeRoutesDriftCheck({ routesFile, startupHash, terminate }: {
  routesFile: string;
  startupHash: string;
  terminate?: () => void;
}): () => void {
  const die = terminate ?? (() => setTimeout(() => process.exit(1), 250).unref());
  return () => {
    let current: string;
    try {
      current = routesFileHash(routesFile);
    } catch {
      current = "<unreadable>"; // a missing file is drift too: the policy behind us is gone
    }
    if (current !== startupHash) {
      console.error(`[adapter] routes drift: ${routesFile} changed since start (startup ${startupHash.slice(0, 16)}, now ${String(current).slice(0, 16)}) — exiting for supervisor restart`);
      die();
      throw new RoutesDriftedError(`routes file changed since adapter start (startup hash ${startupHash.slice(0, 16)}, current ${String(current).slice(0, 16)})`);
    }
  };
}

/** Build a dispatch(repo, event) that forwards to the owning instance's /tasks. */
export function makeRouteDispatch(routes: Route[]) {
  const byRepo = new Map(routes.map((r) => [r.repo, r]));
  return async (repo: string, event: any) => {
    const route = byRepo.get(repo);
    if (!route?.target) throw new Error(`no /tasks target configured for ${repo}`);
    const res = await fetch(`${route.target.replace(/\/$/, "")}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(route.token ? { authorization: `Bearer ${route.token}` } : {}),
      },
      body: JSON.stringify({ requestId: intakeRequestId(event), content: renderIntakeContent(event) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`factory for ${repo} rejected task (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
}

// Standalone entrypoint.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = process.argv[2] ? Number(process.argv[2]) : 9700;
  const routesFile = process.argv[3];
  if (!routesFile) {
    console.error("usage: node factory/adapter.ts [port] <routesFile> [logPath]");
    process.exit(1);
  }
  const routes = loadRoutes(routesFile);
  // Hash the same bytes we just parsed, so startup and per-request checks compare like with like.
  const startupHash = routesFileHash(routesFile);
  const logPath = process.argv[4] ?? "data/intake-adapter.jsonl";
  startIntakeServer({
    port,
    host: process.env.ADAPTER_HOST ?? "127.0.0.1", // reachable only behind a TLS proxy with ADAPTER_HOST set
    routes,
    dispatch: makeRouteDispatch(routes),
    logPath,
    routesDriftCheck: makeRoutesDriftCheck({ routesFile, startupHash }),
  }).then(({ server, port: actualPort, host }) => {
    console.log(`adapter listening on http://${host}:${actualPort} (routes: ${routes.map((r) => r.repo).join(", ")}, routes-hash ${startupHash.slice(0, 16)})`);
    const shutdown = () => {
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }).catch((e) => {
    console.error("adapter failed to start:", e);
    process.exit(1);
  });
}
