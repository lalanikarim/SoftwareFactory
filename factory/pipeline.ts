// The drydock software factory, composed as a pi-durable extension on the
// engram core (issue #30 phase 1). One instance per managed repo:
//
//   createCoreInstance({
//     config: loadConfig(per-repo overrides),
//     extraExtensions: [factoryPipeline(...)],
//     rootAgent: { instructions: ORCHESTRATOR_INSTRUCTIONS, tools: [...] },
//   })
//
// The core provides the harness, server (with approvals, sandbox manager,
// exactly-once /tasks), and model catalog. This extension adds the factory's
// business logic: worker/reviewer tasks + delegate/open_draft_pr/merge_pr/
// note_lesson tools. Nothing here is generic — it all stays in drydock.

import { join } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import { factoryWorkerTask, factoryDelegateTool } from "./worker.ts";
import { factoryReviewerTask, makeReviewerRoleTools } from "./reviewer.ts";
import { openDraftPrTool } from "./open-draft-pr.ts";
import { mergePrTool } from "./merge-gate.ts";
import { noteLessonTool } from "./lessons.ts";
import type { PathScope } from "./path-scope.ts";

/**
 * The orchestrator prompt.
 *
 * This is a function rather than a constant because a repo whose registry policy forbids merging
 * must not be instructed in step 6 to call a tool it no longer has: an agent told to do something
 * impossible tends to find a way (bash has `gh pr merge`, and the worker's shell is one delegate
 * away). The instruction and the capability are derived from the same flag so they cannot drift.
 */
export function orchestratorInstructions({ autoMerge = true }: { autoMerge?: boolean } = {}): string {
  const step6 = autoMerge
    ? '6. Call merge_pr with {"issueNumber": <n>} to merge the draft PR. The core approval hook blocks this call until a human approves its key; do not retry while it is blocked — report that the merge is awaiting approval and stop. If it returns { alreadyMerged: true } or { error: "already merged" }, the PR was merged out-of-band; note it and continue.'
    : '6. STOP here. This repository\'s policy does not allow the factory to merge, so you have no merge tool and must not attempt one by another route (no `gh pr merge`, no git push to the base branch). Report that the draft PR is ready for human review and end your turn.';
  const step7 = '7. Call note_lesson with {"text": "<one durable lesson, e.g. a review concern that recurred>"} only when this run produced a genuinely reusable finding for future runs of THIS repo. Skip otherwise.';
  return [
    "You are the orchestrator of a software factory. You coordinate work on GitHub issues for this repository.",
    "",
    "For each issue you are asked to work, follow these steps in order:",
    '1. Call delegate with {"issueNumber": <n>} to run the sandboxed worker.',
    "2. If the worker reports it could not complete, or its report looks incomplete, re-delegate once with a note about what was missing.",
    '3. Call open_draft_pr with {"issueNumber": <n>, "title": "<concise title>", "summary": "<1-3 sentence summary>"} to push the branch and open a DRAFT PR. This tool first runs an independent read-only review of the committed branch; if the review fails, no push or PR happens and you get the findings back.',
    "4. If the review failed: re-delegate the worker with the reviewer's concerns included in your note (the stale-branch path), then call open_draft_pr again.",
    '5. When open_draft_pr succeeds, it returns { prUrl, isDraft: true }. Summarize the PR for the user.',
    step6,
    step7,
  ].join("\n");
}

/** The auto-merging shape (every fixture repo runs this today). */
export const ORCHESTRATOR_INSTRUCTIONS = orchestratorInstructions();

export interface PipelineOptions {
  workDir: string; // absolute workRoot (…/factory-instances/<repo>/work)
  fixturesRepo: string; // owner/repo
  ghToken?: string;
  modelRef: { provider: string; modelId: string };
  image?: string; // sandbox image (worker + reviewer setup containers)
  testCommand?: string;
  setupCommand?: string | null;
  wallSecsPerIssue?: number;
  lessonsFile?: string; // note_lesson target + worker lesson source
  sandboxPolicy?: { allowImages: string[]; mountRoot: string } | null;
  /** Which paths open_draft_pr may push (from the repo registry; see factory/path-scope.ts). */
  pathScope?: PathScope;
  /**
   * Registry policy (factory/repo-registry.json `autoMerge`). When false, merge_pr is not registered
   * at all and the orchestrator prompt stops at the draft PR — capability removal rather than a
   * runtime refusal, so there is no approval to grant and nothing to forget to check.
   * Defaults to true; the caller (factory/main.ts) reads it from the registry, never from config.
   */
  autoMerge?: boolean;
}

export function factoryPipeline(opts: PipelineOptions) {
  const lessonsFile = opts.lessonsFile ?? join(opts.workDir, "..", "lessons.md");
  const image = opts.image ?? process.env.FACTORY_SANDBOX_IMAGE ?? "factory-sandbox:latest";
  const workerTaskDef = factoryWorkerTask({
    workDir: opts.workDir,
    fixturesRepo: opts.fixturesRepo,
    image,
    testCommand: opts.testCommand,
    setupCommand: opts.setupCommand,
    wallSecsPerIssue: opts.wallSecsPerIssue,
    lessonsFile,
    sandboxPolicy: opts.sandboxPolicy,
  });
  const reviewerTaskDef = factoryReviewerTask({
    workDir: opts.workDir,
    fixturesRepo: opts.fixturesRepo,
    image,
    setupCommand: opts.setupCommand,
    wallSecsPerIssue: opts.wallSecsPerIssue,
    sandboxPolicy: opts.sandboxPolicy,
  });

  return defineExtension({
    name: "factory",
    tools: [
      factoryDelegateTool({ taskDef: workerTaskDef, modelRef: opts.modelRef }),
      openDraftPrTool({
        workDir: opts.workDir,
        fixturesRepo: opts.fixturesRepo,
        ghToken: opts.ghToken ?? "",
        modelRef: opts.modelRef,
        reviewerTaskDef,
        testCommand: opts.testCommand,
        pathScope: opts.pathScope,
      }),
      // Capability removal, not a runtime check: with autoMerge=false the orchestrator never sees a
      // merge tool, so a policy violation would require inventing one rather than misclicking.
      ...(opts.autoMerge === false
        ? []
        : [mergePrTool({ fixturesRepo: opts.fixturesRepo, ghToken: opts.ghToken ?? "" })]),
      noteLessonTool(lessonsFile),
      ...makeReviewerRoleTools({ workDir: opts.workDir, testCommand: opts.testCommand }),
    ],
    tasks: [workerTaskDef, reviewerTaskDef],
  });
}
