// poc/.env.example must carry the real Aurora endpoint (issue #19), not a stale
// <aurora-host>:8000 placeholder, and stay consistent with poc/.env where one
// exists (modulo the intentionally-secret OPENAI_API_KEY).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ENV_EXAMPLE = join(ROOT, "poc", ".env.example");
const ENV_REAL = join(ROOT, "poc", ".env");

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

test(".env.example no longer contains the <aurora-host> placeholder", async () => {
  const text = await readFile(ENV_EXAMPLE, "utf8");
  assert.ok(!text.includes("<aurora-host>"), "stale <aurora-host> placeholder still present");
});

test(".env.example carries the real Aurora endpoint", async () => {
  const env = parseEnv(await readFile(ENV_EXAMPLE, "utf8"));
  assert.equal(env.OPENAI_BASE_URL, "http://aurora.infinidigm:8888/v1");
});

test(".env and .env.example agree on OPENAI_BASE_URL (when .env exists)", async (t) => {
  let text;
  try {
    text = await readFile(ENV_REAL, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      t.skip("poc/.env not present in this checkout");
      return;
    }
    throw err;
  }
  const example = parseEnv(await readFile(ENV_EXAMPLE, "utf8"));
  const real = parseEnv(text);
  assert.equal(real.OPENAI_BASE_URL, example.OPENAI_BASE_URL);
});
