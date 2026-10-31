// Token accounting report for one or more factory instances (Phase 6 measurement).
//
//   node --experimental-strip-types gates/m5-token-report.mjs <instance-root-or-db> [more...] [--json]
//
// Accepts anything findStoreDb understands: a store path, an instance root (<slug>/engram-data/...), or a
// parent directory holding several repo slugs (what the supervisor and the gates create). Reads the durable
// `pi.usage` documents, so it works on instances that have long since been closed — which is the whole
// point: a run whose numbers were never observed by an attached client is still measurable.
//
// Cost is intentionally not reported. The endpoint we run against reports zero for every cost field, so a
// dollar column here would be a fabricated number; tokens are what this fleet can actually attest to.

import { findStoreDb, formatUsage, readInstanceUsage } from "./usage.ts";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const targets = argv.filter((a) => !a.startsWith("--"));

if (targets.length === 0) {
  console.error("usage: m5-token-report.mjs <instance-root-or-db> [more...] [--json]");
  process.exit(2);
}

const reports = [];
for (const target of targets) {
  const dbPath = findStoreDb(target);
  if (!dbPath) {
    console.error(`no durable store found under ${target}`);
    continue;
  }
  reports.push({ target, usage: readInstanceUsage(dbPath) });
}

if (reports.length === 0) {
  console.error("nothing to report");
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  for (const r of reports) {
    console.log(`\n=== ${r.target}`);
    console.log(formatUsage(r.usage));
  }
  if (reports.length > 1) {
    const sum = reports.reduce(
      (acc, r) => acc + r.usage.total.totalTokens,
      0,
    );
    console.log(`\n=== ALL TARGETS: ${sum} tokens across ${reports.length} instance(s)`);
  }
}
