# Superagent — design

**Date:** 2026-11-03
**Revision:** 3 (see "What changed in revision 2" and "What changed in revision 3")
**Status:** design approved, not implemented
**Branch:** `feature/superagent`, cut from `feature/auto-pilot`
**Research folder:** `C:\workspace\claude\research\super-agent\docs\` (outside this repo)
**Background research:** `01-dsh-concepts.md` in the research folder (DeepSeek DSH superagent prototype, concepts numbered 1–30)
**Reviews:** builder check (revision 1, resolved in place); Codex review `03-codex-spec-review.raw.md` in the research folder (14 findings, all folded into revision 2); revision 1 kept there as `02-superagent-design.rev1.md`

Labels used below: **[Decided]** = decided by the user during brainstorming. **[Author's call]** = chosen by the design author; the user may override. Unlabelled = consequence of the two. Code references are to `feature/auto-pilot` unless marked `main`; SDK references are to the installed `@anthropic-ai/claude-agent-sdk` 0.3.231 (`sdk.d.ts`).

## What this is

A Prompt Cockpit feature that takes one idea and carries it all the way to "ready to try" without the user opening, briefing or babysitting sessions. Today the user does this by hand: brainstorm → new session to review the spec → new session to plan → new session to review the plan → new session to execute → test, plus more sessions for every round of feedback, and waiting out the Claude usage cap in between. The user is acting as the router. The superagent replaces that glue.

A **job** is one idea moving through a configurable **pipeline** of **phases**. Each phase is done by one or more **attempts**; each attempt is a fresh **worker** session (a Cockpit session with a role, a model and a prompt). Hand-offs between phases are files, never conversation memory. A deterministic **sequencer** (code) moves the job from phase to phase and enforces every limit. A cheap **router** model is called only for a narrow set of recovery and attention choices, fully isolated and stateless per call, so its context cannot grow.

## Why

The thinking already happens in agents. What costs the user time is the glue between phases and the waiting. Success is: hand over an idea, get notified only when the result is ready to try, when there is a question only the user can answer, or when the job is genuinely stuck.

## What changed in revision 2

All from the Codex review (`03-codex-spec-review.raw.md`, finding numbers in brackets):

1. Router is now launched fully isolated (no settings files, tools, skills, MCP, Claude Code preset), with a whole-request size limit, deterministic truncation, and a cheap-model allowlist. [1]
2. The "80% context checkpoint" promise is dropped: context usage is only measured after a turn ends. Replaced by bounded work units (`maxTurns` per role, one task per worker) plus post-turn rotation as a weaker backstop, and a spike for a real mid-turn hook. [2]
3. Results are now per-attempt, published atomically, identity-checked and validated against required artifacts before the job advances. [3]
4. Every retry path is bounded: attempt caps per phase/task, back-off, stall deadline, repeated-error detection, terminal escalation. Budget is checked before every launch. [4]
5. Recovery honestly promises at-least-once, with attempt IDs persisted before launch and finished results reconciled before re-running. [5]
6. Usage-cap events are recorded durably in a provider-cooldown store shared with auto-pilot; a missing result during a cooldown is classified as a cap, not a failure; paused jobs after a restart resume with a new attempt. [6]
7. The router no longer makes technical calls. Disputed blockers go to a bounded **verifier** worker; the stand-in decides its own assume/escalate. The router only picks recovery actions and writes notification text. [7]
8. `AskUserQuestion` from any unattended worker is denied with an instruction to file the question in its result. [8]
9. Phases declare inputs/outputs; config validation checks dependencies; v1 only allows validated compositions; minimal `tasks.json` schema and test-failure routing are specified. [9]
10. Durable per-attempt usage ledger covering every model call including subagents and router; 5.5 models must be added to `src/pricing.json`; token budget fallback for unpriced models. [10]
11. Runner gains explicit session options (tools, `additionalDirectories`, `maxTurns`, setting sources); stand-in is truly read-only; relay turns are serialised; concurrency counts live sessions. [11]
12. Claude-only in v1 everywhere, including the router; provider fallback is entirely in the last milestone. [12]
13. Review files are committed; the ledger is archived before worktree removal; notification exceptions are named. [13]
14. No shared heartbeat with auto-pilot; separate timers, shared ownership hooks, notifications and cooldown store. [14]

## What changed in revision 3

From the Plan 1 spikes (`docs/superpowers/spikes/2026-11-03-superagent-spikes.md`):

1. Router isolation: `settingSources: []` alone is no longer the specified option set. It dropped the user's `apiKeyHelper` (`apiKeySource: "none"`) and the isolated call failed with "Not logged in". An auth route for the router is now an explicit requirement (see "Isolation"), and the 6000-token `routerMaxInputTokens` default is marked unvalidated.
2. Permissions: `auto` is no longer assumed to deny or to never ask. It asks via `canUseTool` for `AskUserQuestion`, so the interceptor denial is mandatory, and every worker except the brainstormer (whose `AskUserQuestion` follows "Questions from unattended workers") has its `canUseTool` calls denied regardless of classifier outcome. The classifier deny path stays unobserved, so `auto` is not relied on to block risky Bash.
3. Usage ledger: the ledger field is `result.modelUsage` as a per-model delta from the session's previous result, not a separately captured stream of subagent messages. The `subagent` source tag cannot be derived from it, and permission-classifier and token-count calls are not counted.
4. Router isolation option set and its test: the `query()` call now also passes `mcpServers: {}` and `strictMcpConfig: true`, and the Testing section's isolation assertion covers them plus the chosen auth route.
5. Context drift: `PreCompact` is an observation point (log `trigger` and attempt id), not a control point; the post-turn `handoff.md` backstop is kept unchanged.

## Goals

1. One idea in, a tested result on a local branch out, with spec, spec review, plan, plan review, implementation and tests done by delegated workers. **[Decided]**
2. Two start modes. **Automatic (default)**: agents also do the brainstorming. **Manual**: the user brainstorms with the agent; the superagent takes over once the brainstormer has no questions left. **[Decided]**
3. Survive the Claude usage cap without user intervention: pause and resume on its own. Continuing on another provider (Codex, Grok) is a nice-to-have, delivered last. **[Decided]**
4. A dedicated Superagent view in Cockpit, "control room" layout: jobs, phases, plan tasks, worker sessions, router log, and a "Needs you" list. **[Decided]**
5. Notify the user when done or when their attention is needed. **[Decided]**
6. Pipeline sequence and model-per-role matrix are both configurable. **[Decided]**
7. Works on local-only git repos; push/PR is optional. **[Decided]**
8. A job may span several repos (`--add-dir`-style). **[Decided]**

## Anti-goals — failure even if it technically works [Decided]

1. **Burning tokens unnecessarily.**
2. **Context drift** — any session (router or worker) whose context grows until quality drops.
3. **Requiring too much user attention.**

Every decision below is checked against these three. Where a decision exists mainly to serve one, it says so.

## Non-goals

- Watching GitHub, chat apps or any inbound channel. Jobs start from the Superagent view only. (DSH's gate, mandates, policy versioning, thread subscriptions and outbox — `01-dsh-concepts.md` concepts 6–12, 16 — are deliberately not ported; they exist for multi-user inbound traffic.) **[Author's call]**
- Running while Cockpit is down. Jobs persist but only advance while Cockpit runs (same stance as auto-pilot). **[Author's call]**
- Pushing, opening PRs or merging on its own. **[Decided]**
- A long-lived conversational router. **[Decided]** via "code drives the sequence".
- Exactly-once execution. Recovery is at-least-once (Decision 9). **[Author's call]**
- Non-Claude workers or router in v1 (Decision 13). **[Author's call]**
- Replacing hand-driven Cockpit sessions. The superagent is additive.

## Decisions

1. **Build on auto-pilot, generalising only what must be shared.** Branch `feature/superagent` from `feature/auto-pilot` (unmerged, 45 commits ahead of `main`). **[Decided]** The superagent reuses auto-pilot's DI shape (`createAutopilot({ registry, store, log, tracker, now, timer })`), `json-store.js`, attach flow, derived notifications, approval interceptor, session-removed listener and provider back-off. Generalisation happens **on `feature/superagent`; `feature/auto-pilot` is not modified** (if it changes in review, `feature/superagent` rebases). **[Author's call]**
   - `setApprovalInterceptor` and `setSessionRemovedListener` are single-slot and auto-pilot holds both (`src/session-registry.js:52,74`; `src/autopilot.js:1028,1041`) → multi-handler, each handler scoped to rows it owns.
   - Attach flow only admits pilot-owned sessions (`isPilotOwned`, `src/server.js:47`) → "owned by a supervisor".
   - Notifications are computed from auto-pilot state only → projection accepts multiple sources.
   - Provider back-off lives in auto-pilot's in-memory state → a durable **provider-cooldown store** both supervisors read and write (see "Usage cap").
   - **Not shared:** the heartbeat. Auto-pilot's heartbeat awaits its own evaluation and has its own shutdown deadlines (`src/autopilot.js:27-43`). The superagent runs its own timer. **[Author's call]**

2. **Code drives the sequence and enforces every limit.** The sequencer advances on validated facts (an attempt's result, a review verdict, a round count) and owns all caps: attempts, rounds, turns, stall deadlines, budget, concurrency. Serves anti-goals 1 and 2. **[Decided]** (code drives); limits in code **[Author's call]**.

3. **The router is isolated, stateless, cheap and narrow.** One-shot call per decision, built from a bounded **router card**; nothing carries over between calls except what the sequencer persists. It is launched with no filesystem settings, no tools, no skills, no MCP and its own system prompt (not the Claude Code preset), from a cheap-model allowlist. It never makes technical judgements: it chooses among recovery actions and writes short user-facing text. This is the "cleared regularly" mechanism taken to its limit — cleared every call — and it fixes DSH's biggest weakness (one 24/7 router session bounded only by compaction, `01-dsh-concepts.md` §9.1). **[Author's call]** satisfying the user's "router must not overflow, must be cheap" requirement.

4. **The router never thinks about the work** (DSH concept 3). Technical questions — "is this review blocker real?", "is this assumption safe?" — go to bounded workers that can read the evidence (the verifier, the stand-in). **[Author's call]**

5. **Fresh worker per attempt, bounded work units.** No worker session is reused across phases or attempts. Implementation is one worker per task. Every role has a `maxTurns` limit (SDK option) so no single worker can run unbounded. Inputs are passed as file paths, not pasted contents. Serves anti-goals 1 and 2. **[Author's call]**

6. **Files are the only hand-off, and results are validated before they count.** Every attempt publishes a result atomically into its own attempt directory. The sequencer accepts it only if identity, schema and required artifacts check out (see "Worker contract"). Job progress is derived from validated facts, never from any session's memory (DSH concept 14). **[Author's call]**

7. **Review loops cap at 3 rounds, then carry on.** The author fixes or declines each finding (declines need a one-sentence reason). After the cap, the job proceeds with unresolved findings recorded. Open **blockers** at the cap go to a verifier worker; only a verified blocker reaches the user. Mirrors DSH's review-round cap (`prompts/team/communication.md:92-95`). **[Decided]**; cap value configurable; verifier **[Author's call]**.

8. **Feedback goes through a triage worker** that routes it to a small fix, a sub-plan, or a new job. **[Decided]**

9. **At-least-once recovery.** Attempt IDs are persisted before launch; on restart, finished-but-unprocessed results are reconciled before anything re-runs; anything still in flight re-runs as a new attempt with a recovery note. Workers are instructed to check git state before repeating actions. **[Author's call]**

10. **One git worktree and branch per repo per job**, `superagent/<job-slug>`. Workers commit per plan task; spec, plan, tasks, reviews, brief and test report are committed too. Never push, PR or merge automatically. Local-only repos fully supported. If a folder is not a git repo, the superagent offers `git init` before starting rather than running without isolation. **[Decided]** (worktrees, local support, no auto push/merge); the rest **[Author's call]**.

11. **Multi-repo jobs.** **[Decided]** One **primary repo** (holds the job's artifacts; every worker's `cwd`) plus zero or more **additional repos**, each with its own worktree on the same branch name, passed to every worker through the SDK's `additionalDirectories` option (`sdk.d.ts:1356`, the SDK equivalent of `--add-dir`). Plan tasks name the repos they touch. Acceptance lists one branch per repo. **[Author's call]**: mechanics.

12. **Workers run in `auto` permission mode** by default (per-project override; `default` and `plan` rejected for workers). **[Decided]** Containment to the worktrees is not enforced — an accepted risk. At job start each repo's `.claude/settings.local.json` (gitignored, absent from a fresh worktree) is copied into its worktree so the project's allow rules, plugins and commit guard apply; the original is never modified. **[Author's call]**: the copy, per-project toggle.

13. **Claude-only in v1** for every role including the router. The config keeps a `provider` field so nothing is reshaped later, but validation rejects other providers until the final milestone. Reason: the usage-cap signal (`src/session-registry.js:893-926`), cost tracking (none for Codex, auto-pilot design risk 4), `contextUsage` (`:1427-1431`) and `AskUserQuestion` (auto-pilot Decision 11) exist only for Claude today. **[Author's call]**, from "switching providers is a nice-to-have".

14. **Usage-cap handling is code, not router.** A capped provider stops the router too (Haiku shares the Claude cap), so pause/resume is driven by timers and the cooldown store. **[Author's call]**, forced by Goal 3.

15. **Budget is checked before every launch** (worker attempt, verifier, triage, router call), never mid-attempt — a killed agent leaves a broken tree (auto-pilot's spend-cap reasoning). Over budget → job pauses with a "Needs you" question offering to extend. Serves anti-goal 1. **[Author's call]**

16. **Attention budget.** Three notification types only: **ready to try**, **question**, **stuck**. Named members: a budget extension is a *question*; a terminal failure and a usage-cap pause longer than 12 hours are *stuck*. Everything else, including ordinary pauses, is silent and visible in the view. Workers never address the user directly; they file one concrete question in their result (DSH concepts 1, 15). Serves anti-goal 3. **[Decided]** (notify on done/attention); the rest **[Author's call]**.

17. **Configuration is a global file with per-project overrides**, edited from the Superagent view, never written to a project's `.claude/settings*.json`. **[Author's call]**

## Concepts borrowed from DSH

| DSH concept (`01-dsh-concepts.md` §10) | Where it lands here |
|---|---|
| 1 Attention budget | Decision 16 |
| 2 Stateless router over a persistent store | Decision 3, router card |
| 3 Router does not think | Decision 4 |
| 4 Non-blocking orchestrator | The sequencer never waits inside a model call; all waiting is timers/events |
| 9 (§6) Prompt surface as a tested artefact | Testing: router request budget and prompt-contract tests |
| 13 One worktree per ticket | Decision 10 |
| 14 Lifecycle derived from facts | Decision 6, job states |
| 15 Structured human-attention requests | `question` field in results, "Needs you" |
| 17/18 Store-then-do, recovery accounting | Decision 9 (at-least-once, deliberately weaker than DSH's exactly-once) |
| 19 Reserved human lane | Concurrency: interactive work is never starved |
| §6 Review-round cap | Decision 7 |

## Architecture

```
Superagent view (browser)  ──poll──▶  /api/superagent/*  (src/routes/superagent.js)
                                              │
                                              ▼
           src/superagent/  createSuperagent({ registry, store, log, now, timer, git, router, cooldowns })
             ├─ config.js      global + per-project config, pipeline contracts, model matrix, validation
             ├─ store.js       events.jsonl (source of truth) + state.json (derived cache)
             ├─ sequencer.js   state machine; owns all limits; own timer
             ├─ runner.js      launches/watches attempts via registry.createSession/sendInput (extended options)
             ├─ results.js     attempt directories, atomic result read, validation
             ├─ prompts.js     worker prompts from role templates + job card
             ├─ router.js      isolated one-shot calls; request builder; truncation; schema validation
             ├─ standin.js     automatic-mode brainstorm relay (serialised)
             ├─ worktree.js    git worktree create/inspect/remove/archive
             ├─ usage.js       per-attempt usage ledger, budget checks
             └─ caps.js        cap detection, pause/resume (uses shared cooldown store)
src/provider-cooldowns.js       durable shared store (~/.prompt-cockpit/provider-cooldowns.json), used by auto-pilot too
```

Module split is a suggestion; the DI shape and the boundaries (sequencer decides and limits, runner executes, results validates, router chooses among closed actions) are the design.

### Runner session options [Author's call]

`registry.createSession` today cannot pass tool restrictions or additional directories (`src/session-registry.js:282-311`). The runner needs, per attempt: `model`, `effort`, `permissionMode`, `cwd`, `additionalDirectories`, `maxTurns`, `allowedTools`/`disallowedTools` (or `tools`), `settingSources`, and the appended system prompt. These are added as explicit, optional `createSession` options passed through to `query()` (`src/session.js:235-258`), defaulting to today's behaviour so hand-driven sessions are unaffected.

## Jobs and the pipeline

### Default pipeline [Decided: phases; Author's call: kinds, contracts, outputs]

| # | Phase | Kind | Inputs → outputs (artifact keys) |
|---|---|---|---|
| 1 | brainstorm | author (interactive) | idea → `brief` |
| 2 | spec | author | `brief` → `spec` |
| 3 | spec-review | review (target `spec`) | `spec` → `spec` (revised) + reviews |
| 4 | plan | author | `spec` → `plan`, `tasks` |
| 5 | plan-review | review (target `plan`) | `plan`, `tasks` → `plan`, `tasks` (revised) + reviews |
| 6 | implement | per-task | `tasks` → commits + task reports |
| 7 | test | author | `spec`, `tasks` → `testReport` (incl. "how to try it") |
| 8 | accept | human | `testReport` → accepted / feedback |

### Phase contracts and validation [Author's call]

Each phase declares `inputs` and `outputs` as artifact keys; review phases declare a `target`. Config validation on save checks: every input is produced by an earlier phase; review targets exist; a `per-task` phase has `tasks` available; every role exists in `models`; review phases name an author role; exactly one `human` phase, last; all providers are Claude (v1).

**v1 allows only validated compositions:** remove a review phase or the task reviewer; add extra review phases targeting an existing artifact (e.g. a security review of `plan`); change roles, models, `maxRounds`, `maxTurns`, attempt caps. Arbitrary new phase kinds are out of scope for v1.

**Minimal `tasks.json`:**

```json
[{ "id": "T1", "title": "…", "repos": ["primary"], "dependsOn": [], "acceptance": "one or two sentences", "verify": "command or check the implementer must run" }]
```

Tasks run sequentially in dependency order. The builder may extend the schema.

**Test failure routing:** if the tester's result is `failed` with failing checks, the sequencer appends a fix task (from the tester's findings) to `tasks.json`, runs it through `implement`, then re-runs `test`. Bounded by the phase attempt cap; at the cap → `stuck`.

### Artifact locations [Author's call]

- **Committed** in the primary worktree: `docs/superpowers/specs/<date>-<slug>-design.md`, `docs/superpowers/plans/<date>-<slug>.md`, and under `docs/superpowers/jobs/<slug>/`: `brief.md`, `tasks.json`, review files, task reports, `test-report.md`.
- **Ledger** in the primary worktree, gitignored (existing `.superpowers/` convention): `.superpowers/superagent/<job-id>/attempts/<phase>[/<task>]/<attempt-id>/` holding `result.json`, `handoff.md`, raw notes.
- **Job state** outside the repo: `~/.prompt-cockpit/superagent/jobs/<id>/events.jsonl` (source of truth) and `state.json` (derived cache).
- **Before a worktree is removed**, the ledger is archived to `~/.prompt-cockpit/superagent/jobs/<id>/ledger/`. Nothing is removed automatically.

### Job states

`draft → brainstorming → running(phase) → paused(reason) → needs-you(reason) → accepting → done`, plus `stopped` and `failed`. `paused` reasons: `usage-cap(resetsAt)`, `user`. `needs-you` reasons: `question` (incl. budget extension), `ready-to-try`, `stuck`. State is recomputed from `events.jsonl` plus validated attempt results.

### Concurrency [Author's call]

`maxConcurrentSessions` (default 3) counts **live superagent model sessions**, not jobs — an automatic brainstorm counts as one because relay turns are serialised (only one of its two sessions runs at a time). One extra slot is reserved for interactive work (manual brainstorm, feedback triage) so the user is never queued behind background jobs (DSH concept 19). Superagent and auto-pilot limits are separate. Router calls do not take a slot but are serialised per job.

## Workers

### Worker contract [Author's call]

Each attempt gets a fresh session created with the role's model/effort/`maxTurns` from the matrix (explicitly, never from the cwd's `sessionDefaults`), `cwd` = primary worktree, `additionalDirectories` = other worktrees, `permissionMode` from config, and a prompt built from:

1. The role template (`prompts/superagent/<role>.md` in the Cockpit repo, overridable per project). Templates are self-contained; a Claude template may reference a superpowers skill but must override any skill behaviour that crosses the phase boundary (e.g. the brainstorming skill writes a design doc and invokes writing-plans — the brainstorm phase must stop at `brief.md`).
2. A **job card**: job id, phase id, task id (if any), **attempt id**, title, mode, original idea (verbatim), repos with worktree paths (primary first), input artifact paths, required output paths, the attempt directory, and — for review loops — the round number and previous findings file. For retries and recoveries, a recovery note: "check every worktree's git status and log, and the ledger, before repeating work; continue from `handoff.md` if present".

**Publishing a result.** The worker writes `result.json.tmp` in its attempt directory and renames it to `result.json` as its final action (atomic on the same filesystem):

```json
{
  "jobId": "…", "phaseId": "…", "taskId": null, "attemptId": "…",
  "status": "done | blocked | failed",
  "artifacts": ["relative/paths"],
  "summary": "≤ 60 words",
  "question": null,
  "evidence": { "commits": ["sha"], "checks": [{ "cmd": "npm test", "exit": 0 }] },
  "verdict": "approve | changes",
  "findings": [{ "id": "F1", "severity": "blocker | major | minor", "text": "…", "disposition": "fixed | declined: <reason> | open" }]
}
```

`verdict`/`findings` only for review phases. `question` is one concrete question, only with `status: blocked`, only when the user must answer.

**Validation before the sequencer advances** (`results.js`): identity fields match the attempt that was launched; schema valid; for `done`, every required output path exists and is non-empty; for `implement`, every listed commit exists on the job branch in the named repo and every `verify` check is reported with exit 0; for review phases, findings carry severity/disposition as required. An invalid result counts as a failed attempt with reason `invalid-result`.

**Completion detection.** When a worker's turn ends, the runner first consults the cooldown store and the row's rate-limit state (see "Usage cap"); then reads the attempt's `result.json`. Missing → one nudge ("publish your result") → still missing → failed attempt (`no-result`).

### Questions from unattended workers [Author's call]

Cockpit parks every `AskUserQuestion` regardless of permission mode (`src/session.js:272-290`), which would hang an unattended worker. The superagent's approval-interceptor handler, scoped to superagent-owned rows:
- **Automatic-mode brainstormer:** routes the question to the stand-in (see below).
- **Manual-mode brainstormer:** falls through to the normal approval path — the user answers it in the attached session.
- **Every other role:** denies synchronously with the message "You are running unattended. Put your question in `result.json` with `status: blocked`." The interceptor's synchronous constraint (auto-pilot design) is satisfied because denial needs no model call.

### Default model matrix [Author's call; configurable per project — Decided]

| Role | Default | `maxTurns` (default) | Rationale |
|---|---|---|---|
| router | Claude Haiku 5.5 (allowlist) | 1, no tools | Reads only the router request |
| stand-in | Claude Opus 5.5 | 8 per answer, read-only tools | Judges the user's intent from evidence |
| brainstormer, spec-writer, planner | Claude Opus 5.5 | 60 | Upstream quality decides everything downstream |
| spec-reviewer, plan-reviewer, verifier | Claude Opus 5.5 | 40 | Independent read |
| implementer, tester, task-reviewer | Claude Sonnet 5.5 | 80 | Bulk of tokens, clear plan to follow |
| triage | Claude Sonnet 5.5 | 20 | Small focused judgement |

`maxTurns` defaults are starting points for the builder to tune from real runs. Hitting `maxTurns` without a result counts as a failed attempt (`turn-cap`), with `handoff.md` requested on the nudge so the next attempt can continue.

### Context drift for workers [Author's call]

Primary defence is bounded work units: fresh session per attempt, one task per implementer, `maxTurns` per role, inputs as paths. Cockpit only measures context usage after a turn completes (`src/session-registry.js:948`, `:1421-1431`), and input sent mid-turn is queued (`src/session.js:1-3`), so a mid-turn checkpoint cannot be promised. As a weaker backstop: if a worker's turn ends without a result and its measured context is above a threshold (default 70%), the nudge asks for `handoff.md` instead, and the next attempt starts fresh from it. **Spike:** the SDK exposes a `PreCompact` hook event (`sdk.d.ts:816`, **Confirmed**); check whether it can trigger a reliable mid-turn checkpoint (whether the worker can still write `handoff.md` at that point is **not verified**); adopt only if it proves reliable. **Spike outcome (revision 3):** `PreCompact` fires on manual `/compact` with `trigger` and `custom_instructions`, but a generic `{ continue: true }` return did not affect compaction and no veto was tested, and auto mid-turn firing is unobserved. Treat it as an observation point: the runner logs every firing (`trigger`, attempt id), and nothing depends on it writing `handoff.md` before compaction.

### Retry, stall and repetition limits [Author's call]

All enforced by the sequencer, all configurable:

| Limit | Default | On breach |
|---|---|---|
| Attempts per phase (author/review/test) | 3 | `stuck` |
| Attempts per task | 2 | `stuck` |
| Back-off between attempts | 1 min, then 5 min | — |
| Stall deadline: no new message from an actively running attempt | 20 min (reuses auto-pilot's stale-monitor approach, `src/autopilot.js:773-776`) | attempt closed, counts as failed (`stalled`) |
| Repeated error: same failure signature (reason + normalised first error line) on consecutive attempts | 2 | stop retrying → `stuck` |
| Brainstorm exchanges | 20 | brainstormer writes brief with unknowns as assumptions |
| Review rounds | 3 | carry on (Decision 7) |

Within these limits the router may only choose *how* to retry (see "The router"); it can never extend a limit.

### Permissions

Default `auto` (Decision 12). **Spike outcome (revision 3):** `auto` asks through `canUseTool` for `AskUserQuestion`, so a worker would park unless the interceptor handler denies with the "unattended" message, so the worker can publish `blocked`. What the classifier does with a risky action is **inconclusive**: the model refused a force push itself, and a `curl` writing outside the cwd was silently allowed. Do not rely on `auto` to block risky Bash. The runner denies every `canUseTool` call from a worker regardless of classifier outcome, except the brainstormer, whose `AskUserQuestion` follows "Questions from unattended workers" (Plan 2 adds a test asserting this).

## Automatic-mode brainstorm (default) [Decided: agents brainstorm; Author's call: mechanism]

Two sessions: the **brainstormer** (asks questions, writes `brief.md`) and the **stand-in** (answers as the user would). The stand-in runs with a **read-only tool set** (Read, Grep, Glob; no Write/Edit/Bash) via the runner's tool options, over the worktrees. Its rules:

- Answer from the idea first, the project second, and only then assume.
- Tag every answer `from-idea`, `from-project` or `assumed`. All `assumed` answers are listed in the brief's **"Assumptions made for you"** section, which carries into the spec. The user reviews them at acceptance instead of mid-run (anti-goal 3).
- If a question changes what gets built and nothing in the idea or project hints at an answer, **the stand-in itself escalates** it as a `needs-you` question; the brainstorm waits on that one answer. (In revision 1 the router made this call; it is a technical judgement, so it stays with the worker that has the evidence.)

**Relay, serialised.** The sequencer relays the brainstormer's end-of-turn message to the stand-in and the stand-in's reply back as the brainstormer's next turn, reusing the text-relay mechanics of `src/delegation.js`. Only one of the two sessions runs at a time. `AskUserQuestion` from the brainstormer is resolved asynchronously through the pending-approval path (`resolveApproval`) with the stand-in's answer, scoped to superagent-owned rows and excluded from the bell.

**Bounded.** Exchange cap (default 20) plus a per-brainstorm token cap. If either is reached, the brainstormer writes the brief with remaining unknowns as assumptions. If either session's measured context passes the drift threshold between exchanges, it is rotated: a fresh session starts from the brief-so-far (brainstormer) or from the idea plus the answer log (stand-in).

**Termination.** The brainstorm ends when the brainstormer publishes a valid result (`done`) with `brief.md` ("no questions left, ready for speccing"). The visual companion is disabled.

## Manual-mode brainstorm [Decided]

The brainstorm phase is a normal Cockpit session the user chats in, opened via the attach flow from the job row. Its `AskUserQuestion` calls reach the user as usual. Handover happens when the brainstormer publishes a valid result with `brief.md`, or the user clicks **Hand over** (which asks the brainstormer to write them now). From there the job runs exactly as in automatic mode.

## Review loops [Decided: cap and carry on; Author's call: mechanics]

Round *n*: a fresh reviewer reads the target artifact (+ previous round's findings) and publishes a review file + result (`verdict`, `findings`). If `approve`, the phase completes. If `changes`, a fresh author attempt (same role as the original author) applies fixes or declines with reasons and records dispositions. Repeat until `approve` or the round cap. At the cap:

- No open `blocker` → proceed; open findings are appended to the artifact under "Unresolved review findings".
- Open `blocker`(s) → one **verifier** attempt (Opus, bounded): reads the blocker text, the artifact and the author's disposition, and publishes `verified: true | false` with evidence per blocker. Code routes it: any verified blocker → `needs-you` (question = the blocker, with the verifier's evidence); none verified → proceed with the blockers recorded as "disputed, not verified".

## The router

### What it decides (and nothing else) [Author's call]

| Event | Router chooses between | Bounded by |
|---|---|---|
| An attempt failed or was blocked without a user question (`no-result`, `invalid-result`, `turn-cap`, `stalled`, `failed`, `blocked`) and the attempt cap is not yet reached | retry as-is · retry with the role's alternate model from the matrix · retry with a handoff · escalate as `stuck` | attempt cap, back-off and repeated-error rule (code) |
| A `needs-you` entry or `ready-to-try` is about to be shown | writes the notification text (≤ 40 words) from the card | — |

Everything else — advancing phases, round counting, verifying blockers, assumption safety, budgets, usage caps, which notifications exist — is code or a worker. Adding a judgement point requires a closed action set and a test.

### Router request [Author's call]

Built by code for each call:

- Job title, mode, current phase, one line per completed phase (status + ≤ 60-word summary).
- The last 5 router decisions for this job (action + ≤ 30-word note) — its only "memory".
- The triggering event: attempt reason, the result's `status`/`summary`/`question` fields, attempt count and remaining attempts, and the failure signature.
- The closed set of allowed actions and the output schema.

**Whole-request limit:** the full request (system prompt + card) is measured before sending and must fit `routerMaxInputTokens` (default 6k, unvalidated until the router baseline is re-measured; see "Isolation"); output is limited by `routerMaxOutputTokens` (default 300). **Deterministic truncation order** when over the limit: drop completed-phase lines oldest first → shorten decision notes → truncate the event summary with a path pointer. If still over, no call is made and the event escalates as `stuck`.

Output: `{ "action": "<enum>", "note": "≤ 30 words" }` (plus `text` for notification calls). Code validates; invalid, over-length or timed-out (default 30 s) output escalates as `stuck` — never silently proceeds.

### Isolation [Author's call]

SDK `query()` with: `settingSources: []` (no user/project/local settings and no CLAUDE.md; `sdk.d.ts:1978-1987`), `tools: []` (`sdk.d.ts:1447-1455`), `mcpServers: {}` with `strictMcpConfig: true`, no plugins/skills, a custom system prompt (not the `claude_code` preset Cockpit uses for sessions, `src/session.js:248`), `maxTurns: 1`, and the router model. The model must be on `routerModelAllowlist` (default: Claude Haiku 5.5). The stable part (instructions + schema) comes first so prompt caching applies. Each call's request size, latency, usage and decision are appended to `events.jsonl` and shown in the router log. It is not a Cockpit session row and does not appear in the session list.

**Authentication caveat (revision 3).** The spike showed `settingSources: []` removes the user's `apiKeyHelper` (`apiKeySource: "none"`), so the isolated call failed with "Not logged in". The router therefore needs an auth route that keeps isolation: credentials passed through `env`, or a setting source that carries the helper while excluding project sources. Neither is tested yet; the router plan (milestone 2) picks one and re-measures. Built-in skills and agents still appear in the isolated `init`; their prompt cost is unmeasured. The empty-card baseline `totalInput` is **inconclusive** (no isolated usage was measured; the unisolated control used about 50,191 input tokens), so the 6000 `routerMaxInputTokens` default is unvalidated until re-measured.

**Plan 4 outcome (2026-11-05).** Spike S4b (`docs/superpowers/spikes/2026-11-03-superagent-spikes.md`, "S4b router auth route") settled the route: `settingSources: []` plus an inline `settings: { apiKeyHelper, autoMemoryEnabled: false }` (the user's helper string, read from `~/.claude/settings.json`), run from the router's own neutral cwd. The measured baseline is about 443-465 input tokens for an empty card and about 2,427 for a worst-case card, so the 6000 default holds. The token measurement is a pre-send estimate (UTF-8 bytes / 3 plus a fixed overhead), not a tokenizer count; each call logs it next to the real total input.

**Plan 4 probe (2026-11-05).** The first real router probe failed and changed three things (`.superpowers/sdd/2026-11-05-superagent-p4-router/router-probe-findings.md`). Thinking cannot be disabled on Haiku 5.5: every call thought (117-194 tokens) whatever the options said, and thinking counts as output. `routerMaxOutputTokens` therefore bounds the router's answer (output less thinking tokens), and output spend per call is bounded by `routerMaxOutputTokens + 1000`, the hard `CLAUDE_CODE_MAX_OUTPUT_TOKENS` cap (stated deviation: a call's output spend is no longer bounded by `routerMaxOutputTokens` itself, only by that max + 1000). The pre-send estimate is compared with the router's own request, `result.usage`, not with the spend: `modelUsage` folds in a second, hidden request of about 2,951 input and 21 output tokens on every call (origin unknown), so it stays the spend record only.

## Feedback and sub-plans [Decided: three routes; Author's call: mechanics]

At `accept`, the "Needs you" entry shows the tester's "how to try it", the stand-in's assumptions, and two actions: **Accept** and **Give feedback**.

- **Accept** → job `done`. Branches are left for the user to merge. **Remove worktree** is offered afterwards (archives the ledger first); nothing is deleted automatically.
- **Give feedback** → a fresh triage attempt reads the feedback, spec, plan and test report, and publishes `route: fix | subplan | new_job` with a brief:
  - `fix` → one appended task → implement → test → accept.
  - `subplan` → plan (writes `plan-feedback-N.md` + appended tasks) → plan-review → implement → test → accept, inside the same job and worktrees.
  - `new_job` → creates a new job (automatic mode, idea = the brief); the current job returns to `accept`.

Triage uses the reserved interactive slot.

## Usage cap [Decided: goal; Author's call: mechanics]

**Signal and durability.** Cockpit sets `row.rateLimitHit = { resetsAt, rateLimitType }` on a rejected rate-limit event or the CLI's limit text (`src/session-registry.js:893-926`) — but clears it on the next allowed event and drops the row if the session errors (`:903-905`, `:1507-1518`), so it is easy to miss by polling. The superagent therefore registers a **transition hook** on the registry (a listener fired when `rateLimitHit` is set) and records each hit in the durable **provider-cooldown store** (`~/.prompt-cockpit/provider-cooldowns.json`: provider, `resetsAt`, `rateLimitType`, first seen). Auto-pilot's provider back-off reads and writes the same store (Decision 1).

**Classification.** An attempt that ends without a valid result while a cooldown for its provider is active, or within 60 s of a recorded hit, is classified `usage-cap`, not failure: it does not consume an attempt and does not reach the router.

**When a worker hits the cap:** job → `paused(usage-cap, resetsAt)`. While Cockpit keeps running, the worker session's existing auto-continue timer is armed (`setAutoContinue`, `src/session-registry.js:700`) so the *same* session resumes with context intact. No new superagent session or router call starts for that provider until its cooldown clears.

**Unknown `resetsAt`:** the superagent retries with back-off (15 min, doubling to 2 h). Auto-pilot keeps its own rule (indefinite block until a known reset, `src/autopilot.js:179-193`); the store records `resetsAt: null` and each supervisor applies its own policy.

**After a Cockpit restart:** session rows are process-local and gone, so a job paused on the cap resumes as a **new attempt** of the same phase/task with the recovery note once the cooldown clears.

**Notifying:** silent, except a pause whose `resetsAt` is more than 12 hours away (typically the weekly limit, via `rateLimitType`), which notifies once as `stuck`. Threshold configurable.

## Budget and usage ledger [Author's call]

**Ledger.** Every model call is recorded in `events.jsonl` as a usage entry tied to an attempt (or router call): model, input/output/cache tokens, `costUsd` (or `null` if unpriced), and source (`worker`, `router`, `standin`, `verifier`, `triage`). Entries are written per completed turn as deltas, so a crash loses at most one turn. Cockpit's accumulator is session-local (`src/session-registry.js:259-275`) and subagent messages are filtered before normal accounting (`src/session.js:373-383`); the runner therefore reads usage from the result message rather than capturing subagent messages. **Spike outcome (revision 3):** the ledger reads `result.modelUsage` as the per-model delta from the previous result of the same session (cumulative across turns, observed; subtract only numeric spend fields, since `contextWindow` and `maxOutputTokens` are 0 in the delta; treat a decrease as a reset). It does not read `result.usage` or per-message usage (unreliable). That `modelUsage` includes subagent spend rests on the SDK doc comment and was not independently isolated, so there is no separate `subagent` source: subagent spend is folded into the worker's entry. It excludes the permission classifier and token-count calls, so spend for `auto`-mode workers is undercounted.

**Pricing.** `src/pricing.json` had no entries for the 5.5 models (it listed `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5` and older); entries for Opus 5.5, Sonnet 5.5 and Haiku 5.5 were added (commit 1defa41), verified against Anthropic's pricing page on 2026-11-03 — **Confirmed**. Config validation warns on any unpriced model; budgets for unpriced usage fall back to tokens.

**Budget.** Per job, in notional USD and/or tokens; checked before every launch (Decision 15). Defaults for the builder to propose from early runs. The view shows spend per job, per phase and for the router.

Token-saving measures in the design: paths not contents; isolated, tiny, rare router calls; capped rounds, attempts, turns and exchanges; per-task workers with diff-scoped task review; Sonnet for bulk; stable prompt prefixes.

## Restart and recovery [Author's call]

`events.jsonl` is the source of truth; `state.json` is a derived cache rebuilt on start. Write order for every launch: append `attempt-started { attemptId, phase, task, role, model }` → flush → create the session → append `attempt-session { attemptId, sessionId }`. A truncated final line in `events.jsonl` is ignored on load.

On Cockpit start, for each job:

1. Rebuild state from events.
2. For each attempt with `attempt-started` but no terminal event: if a valid `result.json` exists in its attempt directory, process it now (reconcile); otherwise mark it `interrupted` and schedule a new attempt with the recovery note. `interrupted` does not consume an attempt.
3. `paused` and `needs-you` jobs stay as they are; cap pauses wait on the cooldown store.
4. Orphaned worktrees (no job) are listed, never deleted.

On Cockpit shutdown, live workers are closed by auto-pilot's existing shutdown path (`src/child-tracker.js`, "Shutdown" in auto-pilot's design); their attempts are left in flight and handled by step 2 next start.

## The Superagent view [Decided: control-room layout; Author's call: details]

A dedicated view opened from a **Superagent** button in the top bar (red badge when anything needs the user), as its own browser tab (`/?view=superagent`) because each tab's WebSocket is scoped to one session; the view polls `/api/superagent/*` like auto-pilot's notifications. Three panes:

- **Left — Jobs.** One row per job: title, mode, current phase, status (running / needs you / paused until HH:MM / done). **+ New job** form: idea text, primary folder, optional additional folders, mode (automatic default), optional budget override.
- **Middle — selected job.** Phase chips (done / running / waiting / todo); the task checklist read live from `tasks.json`; attempts with role, model, status, attempt *n*/cap and review round, each with **open** (attach flow) to watch or step in; links to artifacts; spend so far.
- **Right — Needs you + Router.** "Needs you" entries (question with an answer box; ready-to-try with how-to-test, assumptions, Accept, Give feedback; stuck with the reason and Retry / Stop). Router panel: model, calls this job, last request size vs limit, spend, and a log of decisions (event → action → note).

Job-level actions: Pause, Resume, Stop. Settings (pipeline, model matrix, limits, budget, permission mode) are edited from a modal in this view, with validation errors shown inline.

## Notifications [Decided: notify; Author's call: mechanics]

Superagent entries join the derived notification projection (computed from state, nothing stored, nothing to mark read). Types and members per Decision 16. Notification text comes from the router (≤ 40 words) with a code-generated fallback if the router call fails or is skipped. When the user has granted permission, the view (and any open Cockpit tab) shows a browser notification for each new entry. Phase changes, review rounds, retries and ordinary pauses never notify.

## Configuration [Decided: configurable; Author's call: shape]

`~/.prompt-cockpit/superagent/config.json`: global defaults plus `projects["<abs path>"]` overrides. Illustrative shape:

```json
{
  "defaults": {
    "mode": "automatic",
    "pipeline": [
      { "phase": "brainstorm",  "kind": "author",   "role": "brainstormer", "inputs": ["idea"], "outputs": ["brief"] },
      { "phase": "spec",        "kind": "author",   "role": "spec-writer",  "inputs": ["brief"], "outputs": ["spec"] },
      { "phase": "spec-review", "kind": "review",   "role": "spec-reviewer", "author": "spec-writer", "target": "spec", "maxRounds": 3 },
      { "phase": "plan",        "kind": "author",   "role": "planner",      "inputs": ["spec"], "outputs": ["plan", "tasks"] },
      { "phase": "plan-review", "kind": "review",   "role": "plan-reviewer", "author": "planner", "target": "plan", "maxRounds": 3 },
      { "phase": "implement",   "kind": "per-task", "role": "implementer", "taskReview": "task-reviewer", "inputs": ["tasks"] },
      { "phase": "test",        "kind": "author",   "role": "tester",       "inputs": ["spec", "tasks"], "outputs": ["testReport"] },
      { "phase": "accept",      "kind": "human",    "inputs": ["testReport"] }
    ],
    "models": {
      "router":      { "provider": "claude", "model": "claude-haiku-5-5", "maxTurns": 1 },
      "implementer": { "provider": "claude", "model": "claude-sonnet-5-5", "maxTurns": 80, "alternate": "claude-opus-5-5" }
    },
    "routerModelAllowlist": ["claude-haiku-5-5"],
    "routerMaxInputTokens": 6000,
    "routerMaxOutputTokens": 300,
    "limits": {
      "attemptsPerPhase": 3, "attemptsPerTask": 2, "backoffMinutes": [1, 5],
      "stallMinutes": 20, "repeatedErrorStop": 2,
      "brainstormExchanges": 20, "brainstormTokens": null,
      "driftHandoffPct": 70, "longCapNotifyHours": 12
    },
    "maxConcurrentSessions": 3,
    "budget": { "perJobUsd": null, "perJobTokens": null },
    "workerPermissionMode": "auto",
    "copyLocalClaudeSettings": true,
    "additionalRepos": []
  },
  "projects": {}
}
```

`alternate` is the model the router may pick for "retry with alternate model". `provider` must be `claude` in v1 (Decision 13). `routerMaxInputTokens: 6000` is unvalidated (see "Isolation").

## Testing [Author's call]

- **Sequencer (unit, no network):** transitions as a table (event × state → next state/effect) with injected registry, clock, git and cooldown store; every limit's boundary (attempts, back-off, stall, repeated error, rounds, exchanges, budget-before-launch).
- **Results:** stale attempt id rejected; non-atomic partial file ignored; `done` missing a required artifact → `invalid-result`; listed commit absent → `invalid-result`.
- **Recovery:** replay recorded `events.jsonl` fixtures — truncated last line; attempt started with valid result (reconciled, not re-run); attempt started without result (new attempt, not counted).
- **Usage cap:** missed `rateLimitHit` poll still classified via cooldown store; capped attempt does not consume an attempt or call the router; restart while paused resumes as a new attempt.
- **Router:** request size limit and truncation order against worst-case jobs; over-limit → no call, `stuck`; schema validation of good/bad outputs; isolation options asserted on the `query()` call (`settingSources: []`, `tools: []`, `mcpServers: {}`, `strictMcpConfig: true`, custom system prompt, allowlisted model, plus the chosen auth route).
- **Questions:** `AskUserQuestion` from a non-brainstorm worker is denied with the unattended message; manual-mode brainstorm questions reach the user.
- **Config:** contract validation rejects broken compositions (e.g. `per-task` without `tasks`, review without target, non-Claude provider).
- **Prompt surface (DSH §6.9):** every role template states the result contract, atomic publish, phase-boundary stop and recovery-note handling; the stand-in template states tagging and escalation rules.
- **Manual end-to-end:** a toy local repo with no remote plus one additional repo, automatic mode, one forced usage-cap pause, one Cockpit restart mid-implement, one feedback round of each route.

## Suggested sequencing (builder may reorder)

0. Generalise auto-pilot's single-slot hooks, attach ownership and notification projection; add the provider-cooldown store and rate-limit transition hook; add 5.5 pricing; extend `createSession` options. Auto-pilot's tests stay green.
1. Config with contract validation, store (events + derived state), worktrees, results validation, sequencer limits, runner — with a two-phase pipeline (author → human). No UI; tests only.
2. Full default pipeline: review loops with verifier, per-task implementation, test-failure routing, isolated router.
3. Superagent view (read-only first, then actions) and notifications.
4. Automatic-mode brainstorm (stand-in, serialised relay, question routing) and manual-mode handover.
5. Usage-cap pause/resume, budgets and usage ledger, restart recovery hardening, drift handoff.
6. Feedback triage and sub-plans.
7. Non-Claude providers (Codex/Grok) as fallback and as configurable roles, each bringing its own cap, cost, completion and question signals.

## Spikes before or during milestone 1

Outcomes are recorded in [the spikes findings](../spikes/2026-11-03-superagent-spikes.md) (run once each, 2026-11-03).

1. `auto` permission mode through the SDK: what happens when it blocks an action. **Outcome:** `auto` asks via `canUseTool` for `AskUserQuestion`, so the interceptor must deny it; the classifier deny path is inconclusive. Plan 2 adds a runner test denying `canUseTool` calls from every worker except the brainstormer (whose `AskUserQuestion` follows the Questions section) regardless of classifier outcome. ([S1](../spikes/2026-11-03-superagent-spikes.md#s1-auto-mode))
2. A mid-turn hook before auto-compaction (e.g. `PreCompact`) for worker checkpoints. **Outcome:** fires on manual `/compact` with `trigger` and `custom_instructions`; `{ continue: true }` did not block compaction; veto (`continue: false` / `decision: 'block'`) untested; auto mid-turn firing unresolved. Plan 2's runner logs every firing; post-turn handoff backstop kept. ([S2](../spikes/2026-11-03-superagent-spikes.md#s2-precompact))
3. Usage from SDK result messages (including subagent spend), which Cockpit currently filters (`src/session.js:373-383`). **Outcome:** read `result.modelUsage` as a per-model delta from the session's previous result; subagent inclusion rests on the SDK doc comment, not an isolated measurement; classifier and token-count calls are not counted; per-message usage is unreliable. ([S3](../spikes/2026-11-03-superagent-spikes.md#s3-subagent-usage))
4. Router one-shot `query()` with full isolation: confirm no settings, CLAUDE.md, tools or MCP leak in, and measure the actual request size. **Outcome: inconclusive.** The isolated option set showed no tools, MCP servers or plugins, but the call failed with "Not logged in" (`settingSources: []` drops `apiKeyHelper`), so the empty-card `totalInput` is unmeasured and the 6000 default unvalidated. The router plan (milestone 2) must find an auth route (credentials via `env`, or a source carrying the helper) and re-measure. ([S4](../spikes/2026-11-03-superagent-spikes.md#s4-router-isolation))

## Risks and limitations

- Heavy reliance on Agent SDK behaviour Cockpit already notes as fragile (`CLAUDE.md:26`) and on a large `session-registry.js`.
- Cap detection is still best-effort at the source; the transition hook and cooldown store narrow the gap but do not close it.
- At-least-once recovery can repeat side effects (e.g. a duplicated commit); mitigated by the recovery note and commit evidence validation.
- The stand-in may assume wrongly; every assumption is surfaced at acceptance, but a wrong early assumption can cost a whole pipeline run of tokens.
- Notional USD cost on a subscription plan is a proxy, not a bill.
- Unattended workers in `auto` mode are not contained to the worktrees (accepted, Decision 12).
- Multi-repo jobs can be left at inconsistent task boundaries by a crash; the recovery note and per-repo commit evidence cover it.

## Left to the builder

Exact module boundaries; API route shapes; `tasks.json` extensions; `maxTurns`, budget and limit defaults after early runs; visual styling within Cockpit's existing CSS; whether the task reviewer is on by default; how the async stand-in answer resolves `AskUserQuestion` without bell flicker.

## Open questions for the user

None outstanding.
