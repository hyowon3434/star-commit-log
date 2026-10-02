# Commands and schema

All commands accept `--project <root-or-descendant>`; otherwise start at the current directory. Paths with spaces must be shell-quoted. Examples use a placeholder script path: resolve the installed skill directory first.

```powershell
node "<skill>/scripts/star-log.mjs" init --project "<project>" --name "Project" --repos "."
node "<skill>/scripts/star-log.mjs" init --project "<workspace>" --repos "server,client"
node "<skill>/scripts/star-log.mjs" collect --project "<project>" --out "<temporary>/commits.json"
node "<skill>/scripts/star-log.mjs" collect --project "<project>" --since 2026-04-02 --until 2026-10-02 --out "<temporary>/commits.json"
node "<skill>/scripts/star-log.mjs" upsert --project "<project>" --input "<temporary>/records.json"
node "<skill>/scripts/star-log.mjs" export --project "<project>"
node "<skill>/scripts/star-log.mjs" validate --project "<project>"
```

`init` accepts `--language` and `--timezone` (defaults `ko`, `Asia/Seoul`). It preserves existing configuration on rerun. Repository paths must be inside the project and resolve to actual Git roots. Stable generated repository IDs survive later path edits; never reuse an ID for a different repository. History/workbook paths must also remain inside the project.

Config schema version 1: `projectId`, `name`, `repositories:[{id,path}]`, `history`, `workbook`, `language`, `timezone`, `initialMonths`. Defaults: `.star-log/history.json`, `docs/task-history/STAR-작업이력.xlsx`, 6 months. Runtime override: environment variable `STAR_LOG_ARTIFACT_MODULES` or config `artifactModules` points to a dedicated runtime node_modules directory. It is not an application dependency. Node.js 20+ and Git are required.

Input example (UTF-8 JSON):

```json
{
  "tasks": [{
    "id": "task-example-unique-id",
    "title": "주소 검색 개선",
    "situation": "상세 주소 검색 실패로 지도 이동이 불가능했다.",
    "task": "상위 주소로 재검색하여 위치 지정이 가능하게 한다.",
    "action": "주소 정규화 및 단계별 검색을 구현했다.",
    "quantitative": "",
    "qualitative": "상세 주소 검색 실패 시 상위 지역으로 이동하도록 변경했다. 운영 결과는 미확인.",
    "evidence": "git:<repository-id>:<full-sha>; 검증 결과 확인 불가",
    "commits": [{"repoId":"<repository-id>","sha":"<full-sha>","source":"codex-commit"}]
  }],
  "excluded": []
}
```

Historical commit source is `historical-git`; conversation-supported imports use `historical-git-and-conversation`. `source` records provenance, not automated identity verification. The agent is responsible for logging only commits it created outside explicitly authorized backfills. Each task requires a nonempty commits array and all narrative string fields (quantitative may be empty). Every nonempty quantitative field also requires `quantitativeEvidence`, a nonempty string citing the measurement source. Git supplies author, date, subject and body; user input cannot override them. An existing task's supplied narrative replaces the previous narrative; its commits are retained and unioned. Existing task associations cannot be silently reassigned.

Exclusions: `{"repoId":"...","sha":"...","reason":"pure merge, no independently authored change"}`. These are stored for coverage auditing, not shown as work rows. To later promote an exclusion to a task, include its commit in an upsert; the exclusion is removed. A task commit cannot be excluded. Rerunning an exclusion updates its reason without duplication.

Exit codes: 0 success, 1 validation/runtime/lock failure. If export fails after upsert, stderr explicitly says history was saved; retry `export` without recommitting. Do not force a retry loop while Excel is open. JSON writes and workbook replacement use same-directory temporary files and rename. A lock containing PID and timestamp prevents concurrent writers; stale locks require verified manual recovery. Workbook content is generated from history and does not preserve manual workbook edits.

`collect` output includes `since`, `until`, `commits`, `mergeCandidates`. Dates are inclusive calendar dates in the configured timezone, filtered by committer timestamp (shown as 커밋일). The metadata also retains author timestamp. Each commit appears once per repository, even when reachable from multiple refs. Merge candidates require agent review: Git cannot automatically decide whether conflict resolution is a separate user task. No remote network access is needed.


## Workbook presentation

작업 이력 columns: 사용자 ID, 작업명, 최초 커밋일, 최근 커밋일, Situation · 배경, Task · 목표, Action · 실행, Result · 정량, Result · 정성, 검증 근거.
사용자 ID displays unique Git author names for that task, separated by newlines; it is not a login ID. Task/repository identifiers stay in history JSON and 커밋 근거. No history schema migration is required.
Both sheets use gray (#D9D9D9) headers with black text and uniformly white body rows. Filters, dates, wrapping and frozen first rows are retained.
