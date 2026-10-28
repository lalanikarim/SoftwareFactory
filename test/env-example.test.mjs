// .env.example is a template: it must not bake in any local hostname
// (issue #22), so OPENAI_BASE_URL stays a placeholder. The real endpoint
// lives only in the gitignored root .env, which must carry a concrete URL
// when one exists.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const ENV_REAL = join(ROOT, ".env");

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

test(".env.example carries no local-host references", async () => {
  const text = await readFile(ENV_EXAMPLE, "utf8");
  assert.ok(!/aurora/i.test(text), ".env.example still references the local Aurora host");
});

test(".env.example OPENAI_BASE_URL is a placeholder, not a concrete endpoint", async () => {
  const env = parseEnv(await readFile(ENV_EXAMPLE, "utf8"));
  assert.ok(env.OPENAI_BASE_URL, "OPENAI_BASE_URL missing from .env.example");
  assert.match(
    env.OPENAI_BASE_URL,
    /^https?:\/\/<[^>]+>/,
    `expected a placeholder URL (http://<inference-host>:8888/v1), got ${env.OPENAI_BASE_URL}`,
  );
});

test(".env (when present) carries a concrete OPENAI_BASE_URL", async (t) => {
  let text;
  try {
    text = await readFile(ENV_REAL, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      t.skip(".env not present in this checkout");
      return;
    }
    throw err;
  }
  const real = parseEnv(text);
  assert.ok(
    /^https?:\/\/[^\s<]+$/.test(real.OPENAI_BASE_URL ?? ""),
    `.env OPENAI_BASE_URL should be a concrete URL, got ${real.OPENAI_BASE_URL}`,
  );
});
