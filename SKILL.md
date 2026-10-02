---
name: star-commit-log
description: Set up per-project STAR work logs and update a consolidated Excel workbook after Codex successfully creates Git commits. Also use for explicitly requested historical commit backfills. Applies only to configured projects; ordinary questions and uncommitted work are not logged.
---

# STAR commit log

Keep one row per user request, with evidence from successful commits. This is an agent workflow, not a Git hook or background watcher. Never create a commit merely to trigger logging.

## Project setup

Run the bundled `scripts/star-log.mjs` with Node.js. Read [config-and-records.md](references/config-and-records.md) for commands and input schema. `init` creates project-local configuration and appends a bounded instruction block to AGENTS.md without replacing existing instructions. Use project-relative repository paths; several repositories can share one project. Do not alter application dependencies, install hooks, commit generated records, or push automatically.

Resolve the nearest ancestor `.star-log/config.json`. Only act on its registered repositories. If a project has not opted in, setup requires a user request. Installation alone does not opt every project in. The workbook runtime is `@oai/artifact-tool`, discovered in Codex's bundled dependency directory or via `STAR_LOG_ARTIFACT_MODULES` (a node_modules directory). Report missing dependencies; do not silently substitute a writer or change application packages.

## After a Codex commit

1. Before an authorized commit, prepare STAR facts and a stable task ID (e.g. `task-<UUID>`). Look up existing records when continuing a request; reuse its ID only with evidence of continuity. Save unfinished input outside the confirmed history if interruption recovery is needed.
2. After Git succeeds, resolve the full SHA and actual repository. Do not log failed commits or unrelated commits made by the user. Build an input JSON using the reference schema. For the same task, supply the complete updated STAR narrative; commits are unioned automatically.
3. Run `upsert --input <file>`; it validates commits, saves JSON, then exports Excel. Use separate task IDs for unrelated requests even if subjects resemble each other. Never assign one commit to two tasks. For a multi-purpose historical commit, keep one composite task rather than fabricate a split.
4. Report logging failure separately from commit success. JSON is authoritative; an Excel lock or missing runtime leaves the JSON ready for `export` on the next run. Never revert a successful commit because logging failed. Do not overwrite arbitrary workbook files or record passwords, tokens, private keys, or raw diffs in the workbook.

## STAR writing

Use the project's configured language (default Korean).
- Situation: evidenced problem/background. If unknown, say so.
- Task: the user's intended outcome; historical intent must not be invented.
- Action: actual changes and verification, not a restatement of the objective.
- Result quantitative: only evidenced values with units/context. Use an empty string when absent, never zero or "N/A". Record a citation for every nonempty quantitative result. Do not count changed files as business impact.
- Result qualitative: verified behavior or supported benefit. A commit does not prove tests passed, deployment succeeded, or users benefited. Mark unverified outcomes explicitly.
- Evidence: distinguish directly observed tests from numbers claimed in a commit message and from user reports. Record SHA references and bounded command outcomes; avoid sensitive output.

## Historical backfill

Only on explicit request. `collect` defaults to the last six calendar months in the configured timezone, scans local heads and remote-tracking refs, excludes stash/internal refs, and never fetches. It emits commit messages and bounded change summaries plus merge candidates. Review each candidate's diff as needed. Pure merges are recorded as excluded with a reason; independently meaningful merge/conflict-resolution changes become tasks. Git metadata cannot generate meaningful STAR narratives by itself: author them from the evidence; do not mechanically claim success for every subject.

Group commits only when messages, diffs, issue IDs, or available conversation establish the same request. Unknown associations stay separate. Reuse existing SHA mappings on repeat imports. Save the complete backfill input (tasks and justified exclusions) with `upsert`, then compare every collected commit against a task or exclusion. Missing historical validation is "검증 결과 확인 불가"; absent quantities remain blank.

## Workbook layout

All sheets use a gray (#D9D9D9) first-row header with black text and white body rows. Keep filters, wrapped text and frozen headers. Do not introduce alternating colored row fills.
The work-history sheet starts with 사용자 ID, derived from the Git author names of its commits (deduplicated and separated by newlines). Do not infer account IDs or use email addresses. Task ID and repository are omitted from this reader-facing sheet but remain in JSON and the commit-evidence sheet for traceability and idempotency.
When a project's AGENTS.md requires performance measurements, include the recorded before/after values and comparison conditions in quantitative evidence; do not treat missing baseline measurements as an improvement.

## Recovery and verification

`upsert`, `export`, and `init` serialize writes with a project lock. Lock contention exits without modifying history. Locks are not force-deleted on a timer: after a crashed process, verify the recorded PID is no longer running before removing only that lock. Atomic temporary writes preserve the old file on failure. Re-export the authoritative JSON if the workbook is open or manually changed. Ask users to request corrections through the history rather than editing generated Excel cells.

Run `validate` after updates. For initial creation/style changes, export with `--preview-dir <temporary directory>` and inspect both sheet previews. Routine exports keep the same layout. Run `node --test scripts/star-log.test.mjs` after changing the implementation.
