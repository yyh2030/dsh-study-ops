# @local/study-ops

[中文](README.md) · English

A research plugin written for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): the experiment operations desk. It reads the participant table, visit task records, scheduling and follow-up rules into one progress board you can watch every day.

Version 0.3.2 · Requires DSH ≥ 0.2.2-rc.1 · MIT license · Depends on [`@local/research-core`](https://github.com/yyh2030/dsh-research-core)

## Why it exists

When running a longitudinal study, the time-consuming part is usually not the analysis but the daily chores: who is due today, which cell has no record yet, why one identifier has two contradictory responses, and who should be reminded to come back next week. In real projects this information is typically scattered across a few CSVs, one Excel master sheet and someone's memory.

The ops desk puts them under one view: a participant × task matrix expanded by visit, plus an anomaly list, a follow-up due list and a scheduling calendar. It only reads source tables and records human judgement; it does not alter your original records or infer that "this person probably finished it".

## What it does

- **Participant progress matrix**: task columns organized by visit, with cells showing collection state and quality state; supports "all / with anomalies / awaiting follow-up" filters, and clicking a cell shows the source, the basis for the state, and conflicting records.
- **Duplicate response adjudication**: when the same participant × visit × task has multiple records it is marked as a conflict; after checking, you pick one and record a reason, and it can be revoked.
- **Groups and summary**: group cards from the groups in the study definition, with total participants, enrolled participants, completed task count, and anomaly and follow-up counts.
- **Follow-up reminders**: driven by `followups` rules, with the anchor being the latest date on which all required and applicable tasks of that visit have a single valid completion, separating due from overdue; you can mark a follow-up done manually with a reason.
- **Scheduling management**: enter date, start/end time, resource or location, validate the real calendar date and that the end is later than the start, and check for overlaps on the same participant or resource.
- **Anomaly handling**: anomalies bind to a specific observation and rule fingerprint, so a dismissed anomaly reappears if its content changes; exporting JSON and the anomaly CSV includes active/dismissed, time, notes, rule and observation fingerprints.
- **Materials intake check**: scan a materials directory for inventory, parse status, coverage, candidates and gaps; `prep_readiness` judges materials coverage, configuration draft, statistical environment and dry run separately, and lists blockers and items to verify.
- **Study draft**: generate a study definition draft from scanned candidates and preview the diff, using only confirmed, non-pending-mapping candidates and never auto-approving scoring conflicts.
- **Core reads**: can read from core projections or from the compatibility flat files named in the study definition; the UI indicates which source is currently in use.

### Agent tools

The plugin registers 13 tools; query tools return only identifiers and counts by default, without per-person detail:

| Tool | Purpose |
|---|---|
| `study_binding` | The study identity bound to the current session, the resolution source, and whether the plugins agree |
| `study_status` | Participant progress, source health, anomaly and follow-up counts |
| `study_data_health` | Status, size and version of each dataset's committed generations and compatibility flat files |
| `flow_projection` | Total and enrolled counts, sex composition, group cards, task state summary, anomaly and follow-up counts, source health |
| `participants_manage` | Register participants, change status (no automatic enrollment), rename (keeping the old ID and history) |
| `observations_manage` | Publish standard observations, adjudicate duplicate responses, revoke adjudication |
| `task_import` | Import task CSV/TSV/XLSX: preview shows the column mapping, commit publishes observations |
| `followup_manage` | Review follow-up due and completion status, or mark completion manually |
| `study_schedule` | Add or remove visit appointments for the current study |
| `materials_scan` | Scan a materials directory and save a derived index |
| `prep_readiness` | Materials intake and experiment readiness assessment |
| `study_draft_preview` / `study_draft_save` | Generate a study configuration draft, preview the diff, save |

Tools and the UI go through the same `binding.read` / `binding.write` path, so panels show the latest state after a tool changes it, and version conflict decisions are identical.

## Installation

The research plugin suite uses the same installation approach: keep the five repositories in one parent directory and install the business plugins into a profile with `link:`.

```powershell
git clone https://github.com/yyh2030/dsh-research-core.git
git clone https://github.com/yyh2030/dsh-study-ops.git
dsh plugin --profile <profile> add link:<parent directory>\dsh-study-ops
```

You can also use the git form directly:

```powershell
dsh plugin --profile <profile> add git+https://github.com/yyh2030/dsh-study-ops.git
```

Both ways require `research-core` to be a sibling of this plugin — the plugin references the shared core through the relative path `../research-core/host.mjs`. The repositories are private and require access before installation. After installing, restart the process hosting `dsh web`; client panel changes also require a page refresh.

## Configuration

Plugin configuration keys:

| Key | Default | Description |
|---|---|---|
| `studyPath` | empty | Path to the study definition JSON; when empty the UI shows an empty study and allows intake |
| `projectRoot` | session working directory | Base for relative paths, and the default root when no study is configured |
| `pythonPath` | runtime Python | Used when reading `.xlsx` materials; can also be overridden with `DSH_MATERIALS_PYTHON` |

The parts of the study definition (`schemaVersion: 1`) relevant to the ops desk:

```json
{
  "schemaVersion": 1,
  "studyId": "sample-study",
  "name": "Sample study",
  "dataRoot": "./data",
  "participantId": { "pattern": "" },
  "participants": {
    "path": "./participants.csv",
    "idColumn": "participantId",
    "statusColumn": "status",
    "enrolledValues": ["enrolled", "completed"],
    "groupColumns": ["group"]
  },
  "visits": [{ "id": "v1", "label": "Baseline", "order": 1 }],
  "tasks": [{ "id": "t1", "label": "Questionnaire", "visits": ["v1"], "required": true }],
  "followups": [{ "id": "f1", "label": "One-week follow-up", "anchorVisit": "v1", "offsetDays": 7, "earlyDays": 1, "lateDays": 3 }],
  "plugins": { "ops": { "recordsPath": "./records.csv" } }
}
```

- The records table is long-format with required columns `participantId,visitId,taskId,status,date,recordId`, and status values `complete` / `pending` / `failed` / `unknown`. Records must reference the participant table, defined visits and applicable tasks; `date` must be a valid `YYYY-MM-DD`; `recordId` must be non-empty and unique.
- Tasks can set `visits`, `required: false`, `appliesTo: { "group": ["A", "B"] }`. Non-applicable tasks show as "not applicable", and a missing optional task is not an anomaly.
- The ops desk writes its own state to `<dataRoot>/ops/<studyId>/state.json` with a `stateRevision`. Every write must carry the current revision; a stale page or concurrent modification returns 409; writes to the same path are queued and an exclusive lock prevents other processes from writing at the same time. A `.lock` left behind by an abnormal process exit must be removed manually by the operator after confirming the process has ended; queries do not repair it automatically.

### Private study adapters

When you need compatibility with an existing private directory layout, explicitly name a module in `plugins.ops.adapterPath` in the configuration or study definition. It exports `createAdapter({ study, config })` and returns `snapshot(options)`, `mutate(action, payload)` and an optional `export(snapshot)`, and the snapshot structure must match the generic matrix. The generic package does no private path auto-discovery and ships no study-specific parsers, rules or default materials.

## API

Same-origin `/api/study-ops` with the request header `x-study-ops: 1`. GET supports only `status` and `subject`; POST actions support `refresh`, `schedule`, `attendance`, `followup`, `dismiss`, `restore`, `export`, `studyConnect`. Every change, export, re-check and study switch carries the current `studyId`, `studyRevision` and `selectionRevision`; state changes additionally carry `stateRevision`.

Study switching propagates to the other registered research plugins through a shared coordinator: if any plugin is busy or fails validation the whole switch does not take effect, so you never end up with half the plugins on the new study and half on the old one.

## Data and privacy

- Local-first: no network access, no external requests; materials scanning only reads the directory and never moves or rewrites files.
- No names or contact details are stored: an identifier is any non-empty string matching `participantId.pattern`, leading zeros are preserved, and names do not determine enrollment.
- Summary tools do not return per-person detail by default; `flow_projection` only gives counts, groups, states and totals.
- Entries that fail materials parsing are explicitly listed as uncovered and are never filled with guessed content.

## Known limitations

- It does no statistics and does not modify original records; `complete` only means the source table confirms completion, not that the task was done well.
- Arbitrary relative visit time windows are not implemented: without a time definition, required tasks for enrolled participants are checked as "should be recorded" and are not computed by day count.
- Scheduling and absence alone do not generate visit completion or follow-up anchors.
- The state lock only guarantees in-process queuing plus cross-process exclusivity; a leftover `.lock` needs manual confirmation before cleanup.
- History and stage rules for private adapters are maintained by the adapter; the plugin only displays them.
- There is no separate test directory in the repository; tests for this plugin's routes live in `research-core/tests/study-ops-routes.test.mjs`.

## License

MIT, see `LICENSE` in the repository root (Copyright © 2026 Yuhui YANG). The license covers plugin code only, not research data: participant information, questionnaire responses, study definitions and data derived from them remain the property of the research party and are not licensed under it.
