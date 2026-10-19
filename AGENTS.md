# AGENTS.md — Working in this repository

This is a **research/documentation repository**, not a code project. The deliverables are markdown reports and one self-contained HTML report under `research/`.

## Conventions

- **Markdown is the source of truth.** `research/*.md` files hold the canonical content; `*.html` files are presentation renderings of the same material. When updating findings, update the `.md` first, then sync the `.html`.
- **Self-contained HTML only.** Reports must not reference external CSS/JS/fonts or remote images — they should render identically offline and in print.
- **Cite everything.** Every non-obvious claim needs a source URL (and a publication date where available). Customer-reported metrics must be labeled "customer-reported" and never presented as universal results.
- **Date-stamp research.** Each report carries a compilation date; refresh the date when content is materially updated.
- **Keep verdicts honest.** Separate verified facts from estimates, and state risks explicitly — including cases where the conclusion is "not feasible yet."

## Research workflow

1. Search/read primary sources (vendor docs, engineering blogs, GitHub repos) before writing or editing claims.
2. Cross-check numbers against at least one source; prefer official documentation over press coverage.
3. When assessing a technology, map its capabilities to concrete requirements with evidence — not marketing language.

## Git workflow

- Never commit on `main`. Work on feature branches (`feature/…`, `chore/…`) cut from an up-to-date `main`.
- Sign off all commits: `git commit -s -m "…"`.
- Stage only the files you intentionally changed (explicit paths, never `git add -A`).
- Push your branch and let the human open/merge the PR — agents do not merge.
