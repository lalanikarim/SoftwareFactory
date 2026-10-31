#!/usr/bin/env node
// Run ONE real task against a repo through the production pipeline, stopping at the draft PR.
//
// Why this exists when G2/G4 already run end to end: those batteries assume a graded fixture repo —
// G2 boots the candidate's HTTP app via the registry's `oracleBoot` to run behavior probes, and G4
// drives a merge approval. Drydock is neither: it exposes no bootable service, and its registry entry
// says autoMerge:false, so a harness waiting on a merge approval would wait forever. Self-work needs
// exactly the production path with a human at the end: clone -> setup -> worker -> independent review
// -> draft PR. Then a person reads the diff and merges it.
//
// Work is dispatched over the instance's own POST /tasks API rather than through the webhook, on
// purpose: that is the "local dispatch" decision — the public listener stays down until its own
// hardening has landed. The webhook path itself is covered separately (G0 plus factory/intake.test.ts).
//
//   node --experimental-strip-types gates/self-run-task.mjs --issue 56 [--repo owner/name] [--timeout-min 45]
//
// Prints the draft PR URL for branch agent/issue-<n>. Never merges, never approves.

import { execFileSync } from "node:child_process";
import { loadFactoryEnv, spawnInstance, defaultConfigPath, postTask } from "./lib.ts";

loadFactoryEnv();

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

const repo = flag("repo", "lalanikarim/drydock");
const issueNumber = Number(flag("issue", "0"));
const timeoutMin = Number(flag("timeout-min", "45"));
const allowExisting = argv.includes("--allow-existing");
if (!issueNumber) {
  console.error("usage: gates/self-run-task.mjs --issue <n> [--repo owner/name] [--timeout-min 45] [--allow-existing]");
  process.exit(2);
}

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

const branch = `agent/issue-${issueNumber}`;
const existing = JSON.parse(
  gh(["pr", "list", "--repo", repo, "--state", "all", "--head", branch, "--json", "number,state,isDraft,url"]),
);
if (existing.length > 0 && !allowExisting) {
  console.error(`branch ${branch} already has PR ${existing[0].url} — close it or pass --allow-existing`);
  process.exit(2);
}

const issue = JSON.parse(
  gh(["issue", "view", String(issueNumber), "--repo", repo, "--json", "number,title,body,labels"]),
);
const labels = (issue.labels ?? []).map((l) => l.name);

// Issue text is untrusted input by construction, so it arrives inside the same delimiters intake uses.
// The instruction that follows them is the harness's, not the issue author's.
const content = [
  `<untrusted issue repo=${repo} number=${issue.number}>`,
  `Title: ${issue.title}`,
  "",
  issue.body ?? "",
  `</untrusted>`,
  "",
  "Implement what the issue above asks for and open a DRAFT pull request.",
  "The acceptance criteria in the issue are the contract: if you cannot satisfy all of them, say so plainly in the PR body instead of weakening the change to make it pass.",
  `Issue labels: ${labels.join(", ") || "(none)"}.`,
].join("\n");

console.log(`[self-run] repo=${repo} issue=#${issueNumber} "${issue.title}"`);
const instance = await spawnInstance({ repo, configPath: defaultConfigPath(repo) });
console.log(`[self-run] instance ready at ${instance.base} (log: ${instance.logPath})`);

try {
  const requestId = flag("request-id", `self-${repo.replace("/", "-")}-${issueNumber}`);
  await postTask(instance.base, instance.token, content, requestId);
  console.log(`[self-run] task accepted (requestId=${requestId}); polling for ${branch} / draft PR (${timeoutMin}m ceiling)`);

  const deadline = Date.now() + timeoutMin * 60_000;
  while (Date.now() < deadline) {
    const found = JSON.parse(
      gh(["pr", "list", "--repo", repo, "--state", "all", "--head", branch, "--json", "number,state,isDraft,url"]),
    );
    if (found.length > 0) {
      console.log(`[self-run] PR ${found[0].url} (state=${found[0].state}, draft=${found[0].isDraft})`);
      process.exitCode = 0;
      break;
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }

  if (process.exitCode === undefined) {
    console.error(`[self-run] no PR on ${branch} within ${timeoutMin}m — inspect the instance log above`);
    process.exitCode = 1;
  }
} finally {
  await instance.close();
  console.log(`[self-run] instance closed; verify with: node --experimental-strip-types gates/self-intake-hardening.mjs <workspace>`);
}
