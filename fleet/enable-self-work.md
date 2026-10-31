# Enabling webhook-driven self-work on drydock

Date: 2026-10-31. Everything below is the remaining deployment path; the code side is finished and verified on `main`.

## Prerequisites

| Item | Status | Evidence |
|---|---|---|
| Registry entry enabled, `autoMerge: false` | done | `factory/repo-registry.json`; capability removal means a self-run has no `merge_pr` tool at all |
| Eligibility label threaded per route | done | `buildRoutes()` in `fleet/supervisor.ts`, `test/fleet-routes.test.mjs` |
| `build` label exists on the repo | done | created 2026-10-31 (GitHub does not auto-create labels; intake matches on name) |
| Path scope excludes `gates/`; `gates/probes/` protected | done | registry + `test/path-scope.test.mjs` |
| `/health` discloses nothing; bodies capped at 1 MiB | done | #59 — oracle `gates/self-intake-hardening.mjs` 6/6 on `main`, G0 20/20, `npm test` exit 0 |

What is **not** done is the part only a person can do: publish the listener and register the webhook. Two decisions are still open — which machine runs the supervisor (needs node 22+, the sandbox image, tailscale, and a checkout with submodules), and whether to move off the account-wide `gh` token before exposing anything (recommended; see #62 notes on token scope).

## 1. Fleet file (deployment, not checked in)

Create `fleet/fleet.local.json` (name it so; only `fleet/data/` is gitignored, so a checked-in-looking `fleet.json` tempts someone to paste a secret into it). Keep the real secret in the environment — the supervisor reads `GITHUB_WEBHOOK_SECRET_<owner>_<repo>` in preference to the file — and copy the shape from `fleet/fleet.example.json`:

```json
{
  "adapter": { "port": 9700, "routesFile": "data/routes.json", "logPath": "data/intake-adapter.jsonl" },
  "factories": [
    {
      "repo": "lalanikarim/drydock",
      "secret": "use-env-override-instead",
      "config": "../factory/config/lalanikarim_drydock.json",
      "instancesRoot": "../factory-instances",
      "allowedSenders": ["lalanikarim"]
    }
  ]
}
```

`allowedSenders` is defense in depth, not decoration: the signature proves GitHub sent the request, the sender allowlist additionally requires that the actor is you. On a public Funnel URL both are cheap and they fail differently.

Required environment (`.env` at repo root is read by `factory/main.ts`; the supervisor passes it through to children): `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `FACTORY_GITHUB_TOKEN`, `FACTORY_SANDBOX_IMAGE`, plus `GITHUB_WEBHOOK_SECRET_lalanikarim_drydock`.

## 2. Start the supervisor

```bash
node --experimental-strip-types fleet/supervisor.ts fleet/fleet.json
```

Expect, in order: `wrote 1 route(s) to …/data/routes.json`, then `[factory] lalanikarim/drydock ready on http://127.0.0.1:<port>/`. Readiness also runs the model-catalog self-check (#54): if the pinned model is absent from the instance's own `/models`, it exits **before** announcing ready — so "ready" means what it says.

## 3. Publish with Funnel, then prove what it discloses

Funnel forwards to the loopback listener; nothing in the factory binds a public interface (the intake server refuses non-loopback without a secret, and we keep it that way).

```bash
# Exact syntax varies by tailscale version (serve vs funnel subcommands); the requirement is only that
# 443 on the funnel host proxies to 127.0.0.1:9700 and nothing else does.
tailscale serve --bg --https=443 http://127.0.0.1:9700
curl -s https://<your-funnel-host>/health                # must print {"status":"ok"} and NOTHING else
```

That curl is the acceptance test for #57 in production: before it, the same request enumerated every configured repository. There is no auth on `/health` by design — liveness has to be pollable — which is exactly why it must say nothing.

## 4. Register the webhook

Events: **issues** only (that is all intake consumes; more events cost signature work and log volume for nothing). Secret must match `GITHUB_WEBHOOK_SECRET_lalanikarim_drydock`.

```bash
gh api repos/lalanikarim/drydock/hooks -f active=true \
  -f "events[]=issues" -H "Accept: application/vnd.github+json" \
  -f config[url]=https://<your-funnel-host>/webhook/github \
  -f config[content_type]=json -f config[secret]=<same-secret> -f config[insecure_ssl]=0
```

## 5. Smoke test, and what a failure looks like

Pick or create an issue that is genuinely worth doing, then:

```bash
gh issue edit <n> -R lalanikarim/drydock --add-label build
tail -f fleet/data/intake-adapter.jsonl      # one dispatch line per accepted event
```

Dispatch → worker clones, runs `npm ci`, implements, gets independently reviewed → **draft PR**, and it stops there. A rejected event (wrong label, bad signature, cross-repo naming) is logged with a reason and returns 200/403 respectively; GitHub retries 5xx, so an instance that is down does not silently lose work — `requestId = issue-<n>` makes the redelivery idempotent.

Two operational facts worth remembering: re-labeling an issue **cannot** re-run it (same `requestId`, permanently deduplicated in the durable store — use a fresh issue or a manual `POST /tasks`), and removing the eligibility label after merge is still manual, as it is for the fixtures.

## Rollback

```bash
gh api -X PATCH repos/lalanikarim/drydock/hooks/<hook-id> -f active=false   # stop intake at the source
tailscale serve remove 443        # or `tailscale funnel --reset`, depending on how it was published
```

Disabling self-work entirely is one line in the registry (`enabled: false`), which the supervisor and `factory/main.ts` both enforce before any child spawns — that path was demonstrated live when the first self-run refused to start.
