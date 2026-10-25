// Durable standing lessons from prior review findings (Phase 5 — feedback loop).
//
// File-based on purpose: per-run sqlite databases are wiped between battery
// runs, but lessons must outlive them. The file is host-side committed state of
// the factory process; the orchestrator writes it through note_lesson only, and
// the worker prompt reads it at spawn (trusted section, outside <untrusted>).

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function lessonsFile() {
  return process.env.FACTORY_LESSONS_FILE ?? join(__dirname, "..", "data", "lessons.md");
}

/** Current lessons document ("" when absent/empty). */
export function readLessons(file = lessonsFile()) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** Orchestrator-facing tool: record one standing lesson distilled from a review
 *  finding. Idempotent — an identical line is not appended twice. */
export function noteLessonTool({ file = lessonsFile() } = {}) {
  return defineTool({
    name: "note_lesson",
    description:
      "Record ONE standing lesson distilled from a review finding, so future worker runs avoid the same mistake. The lesson is one imperative sentence (it may mention the issue number). It is appended durably to the factory's lessons document, which every future worker reads before starting.",
    parameters: Type.Object({
      lesson: Type.String(),
    }),
    replay: "unsafe", // file append; deduplicated by identical line
    execute: async ({ lesson }) => {
      const text = String(lesson).trim().replace(/\s+/g, " ");
      if (!text) return { output: [{ type: "text", text: JSON.stringify({ error: "lesson must be non-empty" }) }], isError: true };
      const line = `- [${new Date().toISOString().slice(0, 10)}] ${text}`;
      const existing = readLessons(file);
      if (existing.split("\n").some((l) => l.trim() === line.trim())) {
        return { output: [{ type: "text", text: JSON.stringify({ recorded: false, reason: "identical lesson already recorded" }) }] };
      }
      appendFileSync(file, (existing ? "\n" : "") + line + "\n");
      return { output: [{ type: "text", text: JSON.stringify({ recorded: true, line }) }] };
    },
  });
}
