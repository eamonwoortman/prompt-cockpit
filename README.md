# Prompt Cockpit

A local browser UI for driving a Claude Code, Grok, or Codex session against a project folder. You pick a provider and a directory, type in the compose box, and the cockpit renders the stream, tool calls, diffs, and a live cost/token strip. It talks to the CLIs over their APIs. It does not wrap a terminal.

![Prompt Cockpit session view with live cost graph](docs/screenshot.jpg)

## What you need

- **Node.js 18+**
- At least one logged-in coding agent on this machine:
  - **Claude**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, then `claude login`
  - **Grok**: the `grok` binary on `PATH` (or set `GROK_BIN`), then `grok login`
  - **Codex**: the [Codex CLI](https://developers.openai.com/codex/cli/) on `PATH` (or set `CODEX_BIN`) and signed in
- The cockpit does not store API keys. It drives whatever login the CLI already has.

The server binds to `127.0.0.1` only. Do not expose it to the network.

## Run

```
npm install   # first time only
npm start
```

Open the URL printed in the console - `http://localhost:4317/?op=<KEYSTRING>` - not the bare `localhost:4317`. The `op=` value is a per-process operator token; the page reads it once, stores it in `localStorage`, and strips it from the address bar. Without it, `/api/*` calls come back `401`. Set `PORT` if 4317 is taken (`PORT=4318 npm start`).

**If you already have a clone from before 0.1.5:** commit history on `main` was rewritten to scoped-commit messages. Sync with `git fetch origin && git checkout main && git reset --hard origin/main` (rebase or drop any local branches based on the old commits).

## First session

1. Choose **Claude**, **Grok**, or **Codex** in the launcher.
2. Point it at a project folder (type a path, pick a recent one, or Browse).
3. Optionally name the session (needed later if another session will `/ask` it) and pick a model. Leave the model on Default to use the CLI's usual one.
4. Click **Start**.
5. Type a prompt and send. Approvals (plan exit, gated tools) show up as a banner above the compose box.

**Resume** lists past sessions for the selected provider. **Start** resumes live; **View** opens the transcript read-only.

Tabs using different providers can run at the same time. A session keeps the provider it was started with, and transcripts can only be resumed by their original provider.

## Once you are in a session

- **Mode cycle** (Shift+Tab on the compose box, or the mode control) - default / plan / accept-edits and the rest of the CLI's modes.
- **Rewind** on a user turn - opens a new session forked at that point. The original stays. Claude can also revert files when this process started the session fresh. Grok is conversation-only (files on disk stay as they are). Codex does not support rewind yet.
- **`@`** in the compose box - file autocomplete in the project.
- **Cost strip** - spend, tokens in/out, cache hit rate, context used. Grok and Codex have an effort picker instead of Claude's thinking-token budget.
- **`/ask Name: …`** - send a task to another named session in the same folder. The answer comes back as a queued turn.

Settings (gear) covers MCP servers, plugins, permission rules, and UI prefs. On Grok, MCP/plugin toggles go through the Grok CLI (`grok inspect` / `grok mcp` / `grok plugin`) and may need a new session before the agent picks them up.

## Status

MVP1-MVP5 shipped (session in a browser, plan/rewind/`@`/diffs, reconnect, live stats, Grok backend, cross-session `/ask`), plus Codex as a third provider. MVP6-MVP7 (Windows-hosted sessions over SSH, phone approvals) are not started. The Superagent view (below) is shipped on the `feature/superagent` branch.

**Auto-pilot** (scheduled unattended sessions). A pilot is a saved configuration
plus a schedule; each firing starts a *new* session in a configured folder,
sends one stored prompt, runs under a chosen permission mode, and is
force-closed when the work is done. Configured from the header's Auto-pilot
pane (Pilots and Logs tabs); notifications for anything needing a human land in
the bell beside it. A global daily spend cap and a per-pilot failure back-off
(auto-disable after 5 consecutive failures) are the guard rails. On Claude, a
pilot can optionally auto-answer the agent's own `AskUserQuestion` prompts by
taking the recommended option.

Four limitations, by design or by available signal:

- **Pilots do not run while the cockpit is down.** They live and die with the
  process - there is no OS cron registration, deliberately. "Cron" invites the
  opposite assumption, so: closing the cockpit stops every pilot.
- **The spend cap is best-effort.** `costForUsage` returns `null` rather than
  guessing for a model with no pricing entry, so runs on an unpriced model
  contribute nothing to the total and can carry it past the cap. The pane says
  so when it happens.
- **The stall timeout is a runaway backstop, not a hang detector.** Only
  `sdk:message` events advance the progress counter, so a single long tool call
  (a build, a test suite, an `npm install`) looks identical to a hang. The
  default is 60 minutes for that reason; anything shorter force-closes healthy
  runs.
- **Rate-limit back-off is best-effort.** The signal is polled and
  self-clearing, so a short limit window can be missed entirely.

Unattended agents in `acceptEdits` or `bypassPermissions` on a timer means
unsupervised writes to real repositories. Run-now, the run log, the visible
pane and the failure auto-disable are the mitigations; the git-commit-guard
covers only its own narrow case.

See `tests/README.md` for automated vs hand-verified coverage, and `backlog.md` for open follow-ups.

## Superagent view (Plan 6)

The **Superagent** button in the header opens a separate tab (`/?view=superagent`) for the superagent supervisor: you give it an idea and one or more git folders, and it runs the job's workflow (the default **Feature** brainstorms, writes a spec and plan, implements and tests; **Troubleshooting** diagnoses and fixes a bug, see Plan 7 below) and stops at **ready to try**, in a worktree per folder or in the folder itself when it is marked in place, with a router picking retries. The tab lists jobs, shows phases, branches, tasks, attempts and artifacts, and puts anything that needs you (a question, a ready-to-try job, a stuck job) in a pane on the right. The job controls are **Accept**, **Stop job** and, on a stuck job, **Retry**, which runs the stuck step again: its earlier failed attempts stop counting toward the caps, and the next attempt continues from the last one's `handoff.md` (when it wrote one) and gets the optional note you typed as an instruction. An answer, Accept or Retry sent from a view that is out of date (the job has since moved on to another question or state) is refused rather than applied to what the job needs now. The bell beside the button lists jobs that need you, and with browser notifications enabled a new entry produces one notification across all open tabs, and none again after a Cockpit restart. Clicking an entry focuses the Superagent tab and selects the job without reloading it, so a draft answer or New job form survives.

- **One owner per machine.** The first Cockpit to start takes `~/.prompt-cockpit/superagent/owner.lock` and runs the supervisor. A second Cockpit's tab says `Superagent is running in the Cockpit on port <N>` and links to it; it has no read-only view of its own.
- **Worker sessions are watch only.** Open one from an attempt's **open** link to watch it. The server refuses its session actions, such as mode changes or interrupting, and closing it (403 `ERR_WATCH_ONLY`), and answers typed input, queue changes and delegation on its socket with a `cockpit:watch-only` frame instead of acting on them, because anything you typed would become part of the attempt the code then judges.
- **Each repo once per job.** Naming the same repository twice in one job is refused (`ERR_DUPLICATE_REPO`). Separate worktree jobs on the same repository are allowed; each works in its own worktree and branch. A folder used in place belongs to that one job until it finishes (`ERR_FOLDER_IN_USE`).
- **The router needs an `apiKeyHelper`.** Without one in `~/.claude/settings.json` the router is off (the view says `Router off: no apiKeyHelper`) and failed attempts get the code-only retries. The router reads none of your settings files except that helper and the file's `env` block (so a gateway `ANTHROPIC_BASE_URL` set there applies to it too).
- **Keep `COCKPIT_HOME` short on Windows.** A long path makes every job fail with `ERR_PATH_TOO_LONG`. Jobs and worktrees live under `<COCKPIT_HOME or home>/.prompt-cockpit/superagent`.
- **Spend, Inspect and Retrospective.** The job pane shows a workflow timeline, per-attempt cost and tokens, and a Spend card (total, workers, router, by stage, by model) read from Claude's transcripts; an unpriced model shows "not available" and a partial figure "at least $X". **Inspect** on an attempt opens its transcript (a live attempt opens the watch tab). Artifacts are kept as snapshots in the job folder, so one a worker later deleted still opens, marked as such. **Retrospective** on a stage or attempt starts a normal Claude session in Cockpit's own repo with a snapshot of that run's transcripts and artifacts, to review the prompts, workflows, skills and plugins that produced it; it opens in a new tab and costs a real session.
- **Not in the view yet:** pause/resume, budgets, answering a budget question, giving feedback, manual mode, a settings modal and stepping into a worker. Each is listed with its later plan in `backlog.md` under "Superagent - planned for later plans".
- **Not probed with a real model in this plan.** `tests/superagent-view-fixture.manual.mjs <cockpitHome> <repoDir>` seeds four jobs into a temp home and checks that nothing would launch before you run a Cockpit on it.

## Superagent workflows and in-place folders (Plan 7)

**Choosing a workflow.** The New job form has a **Workflow** select. **Feature** is the default flow (brainstorm, spec, spec review, plan, plan review, implement, test, accept; the stand-in that answers the brainstorm now runs Sonnet instead of Opus). **Troubleshooting** reproduces a bug, writes a diagnosis, has it reviewed (up to 3 rounds), fixes with a failing test first, verifies and stops at accept, with no human checkpoint before accept; it still stops for you on a bug it cannot reproduce or a reviewer blocker the verifier confirms. An invalid workflow file is listed greyed out with its first error. A `workflow` in `config.json` (also per project) pre-selects one; an unknown or invalid one falls back to `feature` and the form says why. A job keeps the workflow it was created with, so editing or deleting a file never changes a running job. A workflows folder Cockpit cannot read is listed as one invalid entry and the other workflows still load. **Create** waits until the list for the current primary folder has loaded (`Wait for the workflow list to load.`), so a job never silently gets the default instead of your choice.

**Writing one.** A workflow is a JSON file with `format: 1`, an `id` (letters, digits and `-`, up to 24 characters; `config-pipeline` is reserved), `name`, `description`, `artifacts`, `phases` and optional `roles`. Put it in `<COCKPIT_HOME or home>/.prompt-cockpit/superagent/workflows/` (global) or `<primary folder>/.superpowers/superagent/workflows/` (project); the shipped ones are in `workflows/`. The project source beats global, which beats built-in, by `id` (ignoring case, so `Feature` overrides `feature`, and `fix` and `Fix` in one folder are duplicates); a broken override is shown as invalid and still hides the lower one rather than being replaced by it. `artifacts` maps each key the phases use to a path inside the repo; only `{slug}` and `{date}` may appear in it, paths must be unique, and `.git/`, `.superpowers/superagent/` and the generated review and task report paths are reserved. `phases` uses the five kinds `author`, `brainstorm`, `review`, `per-task` and `human`; the last phase is `human`, there is at most one `per-task` and one `brainstorm` phase, and an `author` phase with `"test": true` (at most one, directly after the `per-task` phase when there is one) sends its failures back into the `per-task` phase. A role's prompt is `<primary folder>/.superpowers/superagent/prompts/<role>.md` if present, else the role's `prompt` file (relative to the workflow file), else the shipped `prompts/superagent/<role>.md`, so a custom workflow can reuse every shipped role by name. A role's model comes from the built-in defaults, then the workflow's `roles.<role>`, then `config.json` `defaults.models`, then the project's `models`; the engine roles `verifier`, `stand-in` and `router` are set in `config.json` only. A recorded workflow prompt file that is deleted before a launch makes the job `stuck` with `prompt-missing`. The `pipeline` key in `config.json` still works as a workflow called `custom (config.json)` but is deprecated in favour of a global workflow file.

**In-place folders.** Ticking **Use this folder directly (no new worktree)** on a folder row makes the job switch that folder to its own `superagent/<slug>` branch with `git switch -c` and work there, instead of creating a worktree (a worktree of a very large repo can take about an hour). Don't work in the folder while the job runs. Workers are told the folder is your own checkout (`inPlace` on their job card) and must not run `git clean`, `reset --hard`, `stash` or tree-wide `checkout`/`restore` there, switch branches or create worktrees; nothing enforces this, since `auto` mode does not route Bash through the permission check. Your own uncommitted and untracked changes may stay in the folder: they carry over onto the job's branch, their paths are listed on the workers' card (`pendingChanges`, at most 200), and workers are told to stage only their own files by explicit path and never touch yours (also prompt-only, so check the job's commits before you accept). The create is refused with nothing touched when the folder has a detached HEAD or a rebase, merge, cherry-pick or bisect in progress (`ERR_FOLDER_BUSY_GIT`), is used by another job that is not finished, in place or as the origin of a worktree (`ERR_FOLDER_IN_USE`), or is still on a `superagent/*` branch from an earlier job (`ERR_FOLDER_ON_JOB_BRANCH`; a worktree job from such a folder is refused too). Provisioning checks again right before the switch, adds the job's ledger directory to the repo's local `info/exclude` (it writes no `.gitignore`) and verifies it is ignored. Before every worker launch the folder must still be on the job's branch with no git operation in progress; otherwise nothing launches and the job shows a **paused** `folder-changed` notice with what was found, and it continues by itself once you switch the folder back; if the folder comes back in a different bad state (say on the branch but mid-merge) the notice changes to the new problem, which shows as a new bell entry. That pause is not counted toward any attempt cap. After the job (done, stopped or failed) the folder stays on the job's branch for you to review; Cockpit never switches it back, and it does not detect your own sessions in it.

## License

MIT - see `LICENSE`. Use at your own risk.
