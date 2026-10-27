// One engram core instance per managed repository (issue #30, phase 1).
//
//   node --experimental-strip-types factory/main.ts <owner/repo> [--config path]
//
// Layout created/expected under factory-instances/<repo>/:
//   engram-data/   pi-durable data dir for this instance's harness
//   config/        gates.json (written here by the factory), optional models.json
//   work/          per-issue workspaces (issue-<n>/, review-<branch>/)
//   lessons.md     standing lessons for this repo (note_lesson target)
//
// The core provides harness + server (approvals, sandbox manager, /tasks,
// board, web UI). factoryPipeline() adds the business logic as an extension.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../vendor/engram/app/src/config.ts";
import { createCoreInstance } from "../vendor/engram/app/src/core.ts";
import { loadFactoryConfig } from "./factory-config.ts";
import { factoryPipeline, ORCHESTRATOR_INSTRUCTIONS } from "./pipeline.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const args = [...argv];
  const repo = args.shift();
  if (!repo || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) {
    console.error("usage: node factory/main.ts <owner/repo> [--config path]");
    process.exit(1);
  }
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") {
      configPath = args[++i];
      if (!configPath) { console.error("--config requires a path"); process.exit(1); }
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(1);
    }
  }
  return { repo, configPath };
}

function loadFactoryEnv(): void {
  const envFile = join(__dirname, "..", "poc", ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] ??= v;
  }
}

/** Resolve the factory's model ref. "auto" probes the inference endpoint and
 * prefers the currently-loaded model (the old factory's behavior); an explicit
 * id is used as-is. */
async function resolveModelRef(ref: { provider: string; modelId: string }): Promise<{ provider: string; modelId: string }> {
  if (ref.modelId !== "auto") return ref;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!baseUrl) throw new Error("models.modelId=\"auto\" requires OPENAI_BASE_URL in the environment");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GET /models failed: ${res.status} — check OPENAI_BASE_URL/OPENAI_API_KEY`);
  const j = (await res.json()) as { data?: Array<{ id: string; loaded?: boolean }> };
  const list = j.data ?? [];
  if (!list.length) throw new Error("endpoint reported no models");
  const m = list.find((x) => x.loaded) ?? list[0];
  console.log(`[factory] resolved auto model: ${m.id}`);
  return { provider: ref.provider, modelId: m.id };
}

async function main() {
  const { repo, configPath } = parseArgs(process.argv.slice(2));
  loadFactoryEnv();

  // The core server requires an API token. A stable one comes from the env
  // (supervisor-provided); otherwise generate a per-boot random one and log it.
  if (!process.env.API_TOKEN) {
    process.env.API_TOKEN = randomBytes(16).toString("hex");
    console.log(`[factory] generated API_TOKEN for this boot: ${process.env.API_TOKEN}`);
  }

  const factoryCfg = loadFactoryConfig(configPath ?? join(__dirname, "config", `${repo.replace("/", "_")}.json`));
  if (factoryCfg.repo !== repo) {
    console.error(`[factory] config at ${configPath} declares repo ${factoryCfg.repo}, but was started for ${repo}`);
    process.exit(1);
  }
  // FACTORY_INSTANCES_ROOT: gate scripts and tests use isolated per-run roots;
  // production leaves it unset (repo-root factory-instances/).
  const root = join(process.env.FACTORY_INSTANCES_ROOT ?? join(__dirname, "..", "factory-instances"), repo.replace("/", "_"));
  const dataDir = join(root, "engram-data");
  const configDir = join(root, "config");
  const workRoot = join(root, "work");
  for (const d of [dataDir, configDir, workRoot]) mkdirSync(d, { recursive: true });

  // Factory-owned gate policy for this instance: merge_pr is prompt-tier by
  // default; its exact call shape escalates to the destructive tier so a human
  // MUST approve it (D2: no single-use consumption — idempotency comes from the
  // verified PR state inside the tool).
  const gatesPath = join(configDir, "gates.json");
  writeFileSync(gatesPath, JSON.stringify({
    tiers: [{ tool: "merge_pr" }],
    destructivePatterns: ['^\\{"issueNumber":\\d+\\}$'],
  }, null, 2));

  const image = factoryCfg.sandboxImage ?? process.env.FACTORY_SANDBOX_IMAGE ?? "factory-sandbox:latest";
  // Per-instance declarative files (gates.json) are read from configDir —
  // honored since engram #48 (pin 51b4d39).
  const config = loadConfig({
    dataDir,
    configDir,
    workRoot,
    sandbox: {
      image,
      network: "none",
      allowImages: [image],
      allowMountRoot: workRoot,
    },
    ...(factoryCfg.approvalTtlHours !== undefined ? { approvalTtlHours: factoryCfg.approvalTtlHours } : {}),
  });

  // Optional per-repo model catalog override for the CORE's own default
  // (config/models.json); the factory pipeline uses the explicit ref from the
  // repo config.
  const modelsPath = join(configDir, "models.json");
  const modelsConfig = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : undefined;

  const pipelineOpts = {
    workDir: workRoot,
    fixturesRepo: factoryCfg.repo,
    ghToken: process.env.FACTORY_GITHUB_TOKEN ?? factoryCfg.gitToken,
    modelRef: await resolveModelRef(factoryCfg.models),
    image,
    testCommand: factoryCfg.testCommand,
    setupCommand: factoryCfg.setupCommand,
    wallSecsPerIssue: factoryCfg.budgets.wallSecsPerIssue,
    lessonsFile: factoryCfg.lessonsFile ?? join(root, "lessons.md"),
    sandboxPolicy: { allowImages: [image], mountRoot: workRoot },
  };
  const ext = factoryPipeline(pipelineOpts);
  const rootTools = (ext.tools ?? []).filter((t) => ["delegate", "open_draft_pr", "merge_pr", "note_lesson"].includes(t.name));

  createCoreInstance({
    config,
    modelsConfig,
    extraExtensions: [ext],
    port: 0, // ephemeral; the supervisor records actualPort per instance
    rootAgent: { instructions: ORCHESTRATOR_INSTRUCTIONS, tools: rootTools },
  }).then((instance) => {
    console.log(`[factory] ${repo} ready on http://127.0.0.1:${instance.actualPort}/ (data: ${dataDir})`);

    let keepAlive: NodeJS.Timeout | undefined;
    const shutdown = (signal: string) => {
      console.log(`[factory] ${signal} — closing ${repo}`);
      if (keepAlive) clearInterval(keepAlive);
      instance.close().then(() => process.exit(0)).catch((e) => {
        console.error(`[factory] close failed:`, e);
        process.exit(1);
      });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    keepAlive = setInterval(() => {}, 1 << 30);

    // Surface unhandled rejections instead of dying silently (parity with the
    // old supervise).
    process.on("unhandledRejection", (e) => console.error(`[factory] unhandled rejection:`, e));
  }).catch((e) => {
    console.error(`[factory] failed to start ${repo}:`, e);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(`[factory] fatal:`, e);
  process.exit(1);
});
