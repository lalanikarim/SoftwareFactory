// Issue #25 deliverables: research/drydock-explainer.md (source of truth) and
// research/drydock-explainer.html (self-contained presentation). The markdown
// must carry mermaid flow diagrams; the HTML must use inline SVG diagrams and
// reference no external CSS/JS/fonts/images (AGENTS.md convention).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MD = join(ROOT, "research", "drydock-explainer.md");
const HTML = join(ROOT, "research", "drydock-explainer.html");

test("explainer markdown exists and is a dated report", async () => {
  const text = await readFile(MD, "utf8");
  assert.ok(text.length > 2000, "explainer.md is suspiciously short");
  assert.match(text, /^# /m, "must have a top-level title");
  assert.match(text, /Compiled \d{4}-\d{2}-\d{2}/, "must carry a compilation date");
});

test("explainer markdown contains mermaid flow diagrams", async () => {
  const text = await readFile(MD, "utf8");
  const diagrams = [...text.matchAll(/```mermaid/g)];
  assert.ok(diagrams.length >= 1, "must contain at least one ```mermaid block");
});

test("explainer markdown covers the core components", async () => {
  const text = await readFile(MD, "utf8");
  for (const term of ["adapter", "orchestrator", "worker", "reviewer", "merge gate", "lessons"]) {
    assert.ok(new RegExp(term, "i").test(text), `must explain the ${term}`);
  }
});

test("explainer html exists and uses inline SVG flow diagrams", async () => {
  const text = await readFile(HTML, "utf8");
  const svgs = [...text.matchAll(/<svg[\s>]/g)];
  assert.ok(svgs.length >= 2, "must contain at least two inline <svg> diagrams");
});

test("explainer html is self-contained (no external resources)", async () => {
  const text = await readFile(HTML, "utf8");
  assert.ok(!/<script[^>]+src\s*=\s*["']https?:/i.test(text), "must not load external scripts");
  assert.ok(!/<link[^>]+href\s*=\s*["']https?:/i.test(text), "must not load external stylesheets");
  assert.ok(!/<img[^>]+src\s*=\s*["']https?:/i.test(text), "must not reference remote images");
  assert.ok(!/url\(\s*["']?https?:/i.test(text), "CSS must not fetch remote resources (fonts, images)");
});

test("explainer html carries the same compilation date as the markdown", async () => {
  const md = await readFile(MD, "utf8");
  const html = await readFile(HTML, "utf8");
  const m = md.match(/Compiled (\d{4}-\d{2}-\d{2})/);
  assert.ok(m, "markdown must carry a compilation date");
  assert.ok(html.includes(`compiled ${m[1].toLowerCase()}`) || html.includes(`Compiled ${m[1]}`), "html must carry the same compilation date");
});
