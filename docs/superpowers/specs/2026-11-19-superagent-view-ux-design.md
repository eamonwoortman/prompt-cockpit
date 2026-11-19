# Superagent view: readable job page, spend, inspect and retrospective

Date: 2026-11-19. Branch: `feature/superagent`.

## Intent

The Superagent tab (`public/superagent-view.js`, `public/style-superagent.css`) works but reads as a debug dump: the job description is plain pre-wrapped text with raw URLs, stages are a row of small pills, attempts are one grey line each with only an outcome word, artifacts and the test report are shown as raw text, and there is no notion of what a job cost. The operator wants the page to look professional and be readable at a glance, to see what every agent spent, and to be able to open any worker session and start a retrospective on it so the tooling (prompt-cockpit itself and the skills/agents the workers used, e.g. `fg-unity-agent` in the `fall-guys-dev` plugin) can be improved from real runs.

## Goals

0. **Stage grouping** (settled after the builder check): a stage header is one per non-task phase and one per `(phase, task)` for per-task phases (`fix / fix-carry`), so per-task attempts are grouped, coloured (by their phase), summed and retrospected per task.
1. **Description**: the job idea renders as Markdown (reusing `public/markdown.js`), and every URL, both Markdown links and bare URLs, renders as a link chip (pill) showing the host and a short label (e.g. `dev.azure.com · 171558`, `mediatonicgames.sentry.io · 4908023691`), full URL in the tooltip, opening in a new tab.
2. **Workflow timeline**: the phases render as a horizontal timeline inside a bordered panel titled with the workflow name (e.g. "Troubleshooting"): `[investigate ✓] → [diagnosis-review ✓] → [fix ✓] → [verify ✓] → [accept !]`. Each stage has its own colour (by position in the pipeline); status is shown by icon and fill (done = filled, running = pulsing dot, waiting/needs-you = warning outline, todo = dim outline). Wraps on narrow widths.
3. **Attempts list**: attempts are grouped under their stage (header in the stage's colour, with the stage's attempt count and spend), one card/row per attempt showing: outcome badge (done / failed / question / stopped / running / interrupted / paused-before-launch), role, model, `n/cap`, round, task, duration, tokens, cost, and the result: the attempt's `summary`, or the failure `reason`, or the review `verdict` (+ findings count), or the `question`; commit count when present; "retried, not counted" marker. The result line is truncated to one line and expands on click to the full text (Markdown-rendered).
4. **Spend**: a Spend panel with the job total (all workers + router), and a breakdown by stage, by task (per-task stages), by attempt, and by model, plus the router line. Each attempt row also shows its own cost. Unknown cost (no transcript, unpriced model) is shown as "not available" with the reason in a tooltip, never as $0.
5. **Artifacts**: artifacts render as chips (stage-coloured when the artifact belongs to a stage). The artifact viewer modal renders Markdown for `.md` files and JSON pretty-printed in a code block for `.json`; other text stays plain. The Ready-to-try pane's test report (and any other ready input, and the assumptions section) renders as Markdown too.
6. **Inspect** button on every attempt: live attempt → today's watch-only tab (`/?attach=<sessionId>`); finished attempt → the read-only transcript viewer (`public/history-pane.js`) opened inside the Superagent tab. Disabled with a tooltip when the transcript cannot be found.
7. **Retrospective** button on every attempt and on every stage header (a stage retrospective covers all of that stage's attempts). It starts a normal, interactive Cockpit session (not supervisor-owned, not watch-only) in the prompt-cockpit repo and opens it in a new tab with a seeded first prompt. The operator then continues the conversation to make fixes.
8. **Readability pass** over the whole tab: clear visual hierarchy (job title, status badge, meta line), consistent spacing, section cards instead of uppercase grey labels on bare background, readable line lengths, router log as a small list of decision cards, the right pane's Ready-to-try content rendered rather than raw.

## Non-goals

- No new superagent behaviour (sequencing, limits, caps): this is view + accounting + two launch actions.
- No usage caps or budget enforcement from the new spend numbers (backlog "usage (cost) ledger and usage caps" stays deferred; this only displays spend).
- No settings modal for the superagent.
- The retrospective does not run unattended and does not write reports by itself (option B/C were rejected).
- No light theme work (the app is dark-only today).

## Anti-goals

- Showing a cost that is silently wrong: double counting, $0 for an unpriced model, or a guess. Unknown must look unknown.
- Breaking the existing safety rule of the view: no `innerHTML` for worker/operator text; Markdown goes through `renderMarkdown` (DOM-built, `isSafeHref` protocol allowlist).
- A poll re-render that wipes an expanded result row, a draft answer, or scroll position. Expansion state is kept by attempt id across polls, like `answerDrafts`.
- Hardcoding the operator's own paths (e.g. `C:\workspace\claude\plugins\fall-guys-dev`) anywhere.

## Findings this design rests on (verified 2026-11-19 on job `5f2d3c36`)

- **Transcript per attempt.** `attempt.sessionId` is cockpit's registry id, not Claude's session id. But every worker's first user message is the job card (`prompts.js:204`, sent at `runner.js:547`) containing `"attemptId": "<id>"` (`prompts.js:178`). Parsing that field from the first user message that contains `# Superagent job card` matched all 10 attempts of the job to exactly one transcript each under `~/.claude/projects/<encoded cwd>/`. Plain text search is not enough: later attempts quote earlier attempt ids (previous attempt, handoff), so the match must read the card's own `attemptId` field.
- **Subagents.** Transcripts can have `<sessionId>/subagents/agent-*.jsonl`; their usage belongs to the attempt too.
- **Double counting.** One API response is written as several transcript lines repeating the same `usage` (attempt `057a4c46`: 170 usage lines, 83 distinct `message.id`, every repeated group identical). The live accumulator (`usage.js` `addAssistantMessage`, called from `session-registry.js:1093`) and `global-stats.js` both sum every line. Recorded `attempt-ended.tokens` match the double-counted sum (e.g. 14,938,282 recorded vs 7,276,245 deduplicated).
- **Unpriced prefixed ids.** Some messages report `anthropic.claude-opus-5-5`; `ratesFor` (`usage.js:21`) needs an exact key, so those cost null. Neither `main` nor this branch has that alias.
- With dedupe and prefix stripping the job's worker spend is $16.06 (vs $13.14 with the prefixed rows at $0, and about double with no dedupe).
- Router decisions already persist `usage.costUsd` (`router.js:226`, `store.js:251`).
- Plugin provenance is on disk: `~/.claude/plugins/installed_plugins.json` (install path per `plugin@marketplace`) and `~/.claude/plugins/known_marketplaces.json` (source URL per marketplace, e.g. `fall-guys-dev` → `https://github.ol.epicgames.net/eamon-woortman/fall-guys-dev.git`). A dev clone is a local repo whose `origin` matches that URL (https and ssh forms normalise to the same host/owner/repo).

## Decided by the operator

- Spend for past jobs is derived from the session transcripts, like Cockpit's Settings > Stats already does (not "not recorded").
- Fix the pricing: prefixed model ids (`anthropic.<model>`) price as `<model>` (strip the prefix in `ratesFor`, rather than per-model alias entries).
- Retrospective = option A: an interactive session in the prompt-cockpit repo that analyses and then lets the operator drive fixes.
- The retrospective prompt must tell the session where the tool clones are, resolved from existing resources on the machine, and when that fails the session asks the user. No user-specific path is hardcoded.
- Buttons: Inspect + Retrospective per attempt; Retrospective also per stage.

## Approaches considered

**Spend source.**
1. *Transcripts, deduplicated, persisted at attempt end* (chosen). Exact per-message usage; works for every past job whose transcripts still exist; a figure saved into the attempt's ledger when the attempt ends survives Claude Code pruning old transcripts.
2. *Record `costUsd` from the live accumulator on `attempt-ended` only.* Rejected: the accumulator double counts, and past jobs would show nothing.
3. *Live accumulator, fixed to dedupe.* Needed anyway for live attempts' running figure (see open item below) but cannot cover past jobs alone.

**Retrospective output.** A (interactive session, chosen), B (unattended `retrospective.md` artifact), C (both). B/C rejected by the operator.

**Where tool clone paths come from.**
1. *Resolve from plugin metadata + local search, ask in-session on failure* (chosen; operator's direction).
2. *`config.json` list.* Rejected: user-specific, needs hand editing, no settings UI.
3. *UI path field.* Rejected: no superagent settings surface exists.

## Design

### Server

**A. Pricing fix (`src/usage.js`).** `ratesFor(model)` falls back to the id with a leading `anthropic.` stripped when the exact id is unpriced. The existing explicit aliases in `pricing.json` stay valid. Unit test in the existing usage tests.

**B. Transcript lookup for an attempt (new `src/superagent/transcripts.js`).**
- `findAttemptTranscript(job, attempt)` → `{ claudeSessionId, file, cwd } | null`. Search the project directory Claude Code uses for the attempt's cwd (the job's primary repo worktree, or the in-place folder): `~/.claude/projects/<cwd with every non-alphanumeric character replaced by '-'>`; if that directory does not exist, fall back to scanning all project directories (reuse `listAllSessionFiles`). Only files whose mtime ≥ the attempt's `startedAt` are candidates. A match is the file whose first user message containing `# Superagent job card` has the card JSON's `attemptId` equal to the attempt's id (parse the fenced JSON; do not substring-search).
- `attemptUsage(file)` → `{ costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, byModel, unpricedModels, messages }`, summing each distinct `message.id` once across the main file and its `subagents/*.jsonl`, priced via `costForUsage` (with the prefix fix). A row with no `message.id` counts once on its own.
- Results are cached in memory by `(file, size, mtimeMs)` so the 5 s poll does not rescan transcripts.
- The projects root is injectable (tests point it at a temp dir; same pattern as `global-stats.js`/`session-launcher.js`).

**C. Persisting spend.** (Builder's call, settled after the builder check.) Spend is stored in cockpit's own job directory, not in the worktree and not in `ledger/` (the attempt dir lives in the worktree or the operator's in-place repo, `results.js:45-50`, and `ledger/` is a one-time copy made on stop/accept, `index.js:261-269`): one file `~/.prompt-cockpit/superagent/jobs/<id>/usage.json`, `{ format: 1, attempts: { <attemptId>: { costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, byModel, unpricedModels, claudeSessionId, scannedAt } } }`, written with `json-store.js`'s `updateJson`. Only ended attempts are persisted. Writes happen on the supervisor's own heartbeat (which already reviews every job): for each ended attempt with no entry, scan its transcript and record the result; a failed or missing scan records nothing and is retried on a later heartbeat, never failing or delaying anything. The `GET` routes stay read-only (`host.read`): the view prefers, in order, the `usage.json` entry → an in-memory cached transcript scan (for running attempts, and ended ones the heartbeat has not reached yet) → `null` ("not available", with reason: transcript pruned / not found / unpriced model). Past jobs get their entries the same way the first time the heartbeat sees them, so later transcript pruning does not lose them. Finished jobs (done/stopped/failed) are included in that one-time backfill. The `attempt-ended.tokens` field and `limits.brainstormTokens` keep their current semantics in this change (see open items).

**D. View model (`src/superagent/view-model.js`).** `jobDetail` gains, per attempt: `startedAt`, `endedAt`, `durationMs`, `summary`, `reason`, `verdict`, `findingsCount`, `question`, `commits` (count), `usage` (`{ costUsd, tokens, byModel, unpricedModels } | null`, `usageNote` when null), `transcript` (`{ available: boolean }`). Per job: `spend` = `{ totalUsd, workersUsd, routerUsd, byPhase: [{ phase, usd, attempts }], byTask: [{ task, usd }], byModel: [{ model, usd, tokens }], incomplete: boolean }` where `incomplete` is true when any attempt's usage is unknown (the total is then shown as "at least $X"). Router spend sums `routerDecisions[].usage.costUsd`. `phases` keep their order so the client can colour by index. Usage lookup is async, so `jobDetail` takes an injected `usageFor(attempt)` resolver (the route provides the real one; tests inject a stub), keeping view-model pure.

**E. Routes (`src/routes/superagent.js`).**
- `GET /api/superagent/jobs/:id/attempts/:attemptId/transcript` → `{ claudeSessionId, cwd }` or 404 `ERR_TRANSCRIPT_MISSING`. The client then uses the existing `/api/history/:claudeSessionId?cwd=` route through `history-pane.js`.
- `POST /api/superagent/jobs/:id/retrospective` body `{ attemptId } | { phase, task? }` (a `task` narrows a per-task stage to that task's attempts) → creates the retrospective session (below) and returns `{ id, token }`. Errors: 404 unknown job/attempt/phase, 409 `ERR_TRANSCRIPT_MISSING` when none of the selected attempts has a transcript. Same host gate (`admit`) as the other superagent POST routes.

**F. Retrospective session.**
- Created through the same registry path as `POST /api/sessions` (provider `claude`, cwd = the prompt-cockpit repo root, i.e. the directory containing cockpit's `package.json`; model = the cwd's persisted session defaults like a normal new session). It is a normal user session: not in the superagent's owned set, so not watch-only and not supervisor-owned. Name: `Retro: <job title> · <phase>[ / <task>][ #n]`.
- **Folder access (operator's choice, option A).** The session is created with `additionalDirectories` set to exactly: the Claude projects directory holding the selected transcripts, the job's directory `~/.prompt-cockpit/superagent/jobs/<id>/`, every folder of the job (worktrees or in-place folders), and every resolved plugin dev clone. Nothing else (in particular not `~/.claude/plugins/cache/` or `marketplaces/`). The existing `POST /api/sessions` route does not take `additionalDirectories`, so the retrospective route calls the registry directly with them rather than going through that route.
- The first prompt is sent by the server right after the session is created (`registry.sendInput`), so the click "kicks off" the analysis as the operator asked; the new tab joins a session whose first turn is already running.
- First prompt, built by a new `src/superagent/retrospective.js` (template text in `prompts/superagent/retrospective.md` so it is editable without code changes), contains:
  - the goal: analyse what went wrong or was wasteful in this run and why, and propose concrete changes to (a) prompt-cockpit (superagent prompts in `prompts/superagent/`, workflows in `workflows/`, engine code) and (b) the skills/agents/plugins the worker used; then discuss with the operator and make the changes they approve.
  - the job: title, workflow, stage(s), job id, the job's events file path, the job card of each selected attempt (parsed from its transcript's first job-card user message, the same parse `transcripts.js` does for matching; the runner never writes the card to disk, `runner.js:547`), each attempt's result (`outcome`, `summary`/`reason`/`verdict`), artifact paths, and each attempt's transcript path(s) including subagent files, with its spend.
  - **Tools used and where their source is**: for every plugin skill (`plugin:skill`) or plugin agent the selected transcripts invoked (Skill tool inputs and Agent `subagent_type` with a `plugin:` prefix), one entry with: the installed (read-only) path from `installed_plugins.json`, the marketplace source URL from `known_marketplaces.json`, and the dev clone path if resolved (below), or the line "dev clone not found: ask the operator where it is (or whether to clone it) before editing". Plus a fixed rule: never edit under `~/.claude/plugins/cache/` or `~/.claude/plugins/marketplaces/`; edit the dev clone; follow the plugin's own contribution skill when it has one (e.g. `fall-guys-dev:update-fg-dev`).
  - prompt-cockpit's own repo path (the session's cwd) as the place for cockpit fixes.
- **Dev clone resolution** (server side, bounded, best effort): normalise the marketplace URL to `host/owner/repo`; candidates are git repos found by walking from each of these roots to depth 3, skipping `node_modules`, `.git` and hidden directories: the parent and grandparent of cockpit's repo root, and the parent and grandparent of each of the job's folders. A candidate matches when `git remote get-url origin` normalises to the same `host/owner/repo`. First match wins; ambiguity (several matches) lists all and tells the session to ask. With the operator's layout (`C:\workspace\git\prompt-cockpit…`, clone at `C:\workspace\claude\plugins\fall-guys-dev`) the grandparent `C:\workspace` at depth 3 finds it. Git calls use `-c core.fsmonitor=false` (see CLAUDE.md) and a timeout.
- **Handoff to a new tab.** The server returns `{ id, token }`; the Superagent tab writes them into its own `sessionStorage` under `cockpit:activeSession` (the key `app.js` reads, `app.js:455`) and then calls `window.open('/', '_blank')`. Per the HTML spec a script-opened same-origin tab gets a copy of the opener's `sessionStorage`, so the new tab's `rejoinActiveSession()` joins the retrospective session; the Superagent tab itself never reads that key (`entry.js` does not load `app.js` there). The key is removed from the Superagent tab right after `window.open`. No token goes in a URL.

### Client (`public/superagent-view.js`, `public/style-superagent.css`)

The file is already ~900 lines; split rendering into focused modules matching the rest of `public/`: `superagent-job-pane.js` (middle pane: header, description, timeline, spend, attempts, artifacts), `superagent-format.js` (pure helpers: link chip label, duration, money, token counts, stage colour index; unit-testable like `autopilot-format.js`), and keep `superagent-view.js` for polling, the left and right panes and wiring. Add the new modules to whatever static allowlist serves `public/` if one exists.

Layout sketch of the middle pane:

```
Investigate this ADO issue …                         [needs you]   [Stop job]
Troubleshooting · created 18 Nov 12:05 · in place: FallGuys · $16.42 spent

┌ Description ─────────────────────────────────────────────────────────────┐
│ Investigate this ADO issue (dev.azure.com · 171558) for these two Sentry │
│ issues:                                                                   │
│  • (mediatonicgames.sentry.io · 4908023691)                              │
│  • (mediatonicgames.sentry.io · 4908733049)                              │
│ Use the fg-unity-agent to reproduce the issue organically.               │
└──────────────────────────────────────────────────────────────────────────┘
┌ Troubleshooting ─────────────────────────────────────────────────────────┐
│ (investigate ✓) → (diagnosis-review ✓) → (fix ✓) → (verify ✓) → (accept !)│
└──────────────────────────────────────────────────────────────────────────┘
┌ Spend ── $16.42 total ───────────────────────────────────────────────────┐
│ investigate $9.40 ███████████  diagnosis-review $1.33 █  fix $0.82 …     │
│ by model: opus-5-5 $14.9 · sonnet-5-5 $1.2 · router (haiku-5-5) $0.01    │
└──────────────────────────────────────────────────────────────────────────┘
▌investigate · 5 attempts · $9.40                            [Retrospective]
  [question] #1/3 investigator · opus-5-5 · 14m · 7.3M tok · $4.44
             "Which Sentry issue should be reproduced first?"   [Inspect][Retro]
  [failed]   #2/3 … retried, not counted · invalid-result: tasks.json …  ▸
  …
▌fix / fix-carry · 2 attempts · $0.59                         [Retrospective]
  …
Artifacts: (diagnosis) (tasks) (testReport) (review:diagnosis-review:1) …
```

- Stage colours: a fixed palette of 6-8 distinct hues defined as CSS custom properties in `style-superagent.css` (`--sa-stage-0` …), assigned by phase index modulo palette size, readable on `--bg` (WCAG AA for text on the tinted chip). Status colours (`--ok`, `--warn`, `--error`, `--accent`) stay for outcome badges only, so stage colour and outcome never compete.
- Link chips: a `linkChip(url)` helper builds `<a class="sa-link-chip" target="_blank" rel="noopener noreferrer">`; label = host (without `www.`) + `·` + the last meaningful path segment or numeric id (query/hash dropped); full URL as `title`. Applied to Markdown links and to bare `http(s)://` URLs in text. Implement as an option on `renderMarkdown` (e.g. `renderMarkdown(text, { autolink: true, renderLink })`) so the transcript renderer's behaviour is unchanged by default; `isSafeHref` still applies.
- Expansion state for attempt results is kept in a `Set` of attempt ids across polls; the middle pane re-render keeps scroll position.
- Spend numbers: `$` with 2 decimals (`< $0.01` for small non-zero); tokens compact (`7.3M`, `412k`); "at least" prefix when `spend.incomplete`.
- Inspect / Retrospective buttons are small secondary buttons; Retrospective shows "Starting…" while the POST is in flight and shows the error inline on failure. Inspect is disabled when `transcript.available` is false and the attempt is not live.
- Artifact modal (`#superagentArtifactModal` in `index.html`): replace the `<pre>` with a container that renders Markdown for `.md`, pretty JSON code block for `.json`, plain `<pre>` otherwise; keep the truncation note. Widen to `min(1100px, 94vw)`.
- The history modal (`history-pane.js` + its dialog and `#historyDetailPane` in `index.html`) is initialised in the Superagent tab for Inspect; confirm the superagent body-class CSS does not hide it (dialogs are exempt in `style-superagent.css:7`).

### Tests and docs

- Unit: `ratesFor` prefix fallback; `transcripts.js` matching (card attemptId vs quoted earlier ids, subagent files, mtime filter, missing dir fallback), dedupe by `message.id`, unpriced model reporting; view-model `spend` aggregation and attempt result fields with a stub `usageFor`; `superagent-format.js` helpers (chip labels for ADO, Sentry, GitHub, plain URLs; duration; money); `renderMarkdown` autolink option off by default and on; retrospective prompt builder (plugin extraction from Skill/Agent tool uses, clone resolution with an injected git/fs, "ask the operator" line when unresolved, never a cache/marketplace path as the edit target); route tests for the two new routes (auth/host gate, 404/409 cases).
- Hand-verified only (no jsdom): the layout, colours, expansion persistence across polls, the new-tab handoff. Record these in `tests/README.md` per its convention.
- Docs: `CLAUDE.md` superagent paragraph (spend source, new routes, retrospective, new modules), `README.md` status if it lists superagent UI features, `backlog.md` (remove anything this ships; add open items below), the p6 view design doc only if it states behaviour this changes.

## Left to the builder

- Exact palette values, spacing, typography, icons (Unicode glyphs; no icon font or new dependency).
- Module boundaries inside the client beyond the split above.
- Where exactly in the runner/reconcile path `usage.json` is written, as long as a failure to write it never fails or delays the attempt's end.
- The exact wording of the retrospective template.

## Open items (settled or deferred, recorded for the plan)

- **Live accumulator / Settings > Stats double counting.** Out of scope unless the operator says otherwise; add to `backlog.md` with the evidence above. Consequence: `attempt-ended.tokens` (and so `limits.brainstormTokens`) stays double counted for now; the view's spend does not use it.
- Running attempts show spend from a transcript scan of what is written so far (the transcript is appended live), labelled "so far".
