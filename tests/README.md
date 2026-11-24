# Tests

`npm test` runs the unit suite (`session-registry.test.mjs`, `session-launcher.test.mjs`,
`server-auth.test.mjs`, `permissions.test.mjs`, `sdk-adapter.test.mjs`,
`session-history.test.mjs`, `session.test.mjs`, `event-log.test.mjs`, `usage.test.mjs`,
`context-usage.test.mjs`) via
Node's built-in test runner. Fast, free, no network calls, no Claude CLI
spawned - the registry tests inject a stubbed `startSessionImpl`, and
`session.test.mjs` injects a stubbed `queryImpl` (same pattern, one level
deeper - `startSession` now takes it the same way `createSession` takes
`startSessionImpl`) instead of the real SDK-backed ones.

## MVP4 - live stats panel

`usage.test.mjs` covers `src/usage.js` directly: `costForUsage` against the
copied `src/pricing.json` (input/output/cache-read/cache-write, the legacy
`cache_creation_input_tokens` field, an unpriced model returning `null`
rather than guessing), and `createUsageAccumulator`'s running totals and
cache hit rate. `session-registry.test.mjs` covers the wiring one layer up:
an assistant message with `usage` broadcasts `cockpit:usage` with updated
totals, a fresh `attachClient` gets a zeroed snapshot immediately (not a
blank panel until the first message), and an unpriced model's tokens still
accumulate but get flagged in `usage.unpriced` instead of costing silently
at $0.

**Not covered by unit tests, hand-verified only:** `refreshContextUsage`'s
`getContextUsage()` round trip (same tradeoff as `rewind()`/
`loadEarlierHistory()` - it calls the SDK's `Query` handle directly, not
through an injectable stub) and everything client-side in
`public/stats-panel.js`/`public/history-pane.js` (real websocket messages,
DOM rendering). Verified by hand per the plan's MVP4 Verification section:
cost/tokens/context percentage track a live turn and the header strip
updates as it runs; two sessions open at once each show their own numbers;
`/api/history/:sessionId` renders a past (non-resumed) session read-only
via the resume list's "View" button, with no rewind affordance since
there's no live registry row backing it.

## Auto-compact status precision

`context-usage.test.mjs` covers the pure transform in `src/context-usage.js`
directly: `normalizeAutoCompactThreshold`'s three unit interpretations
(fraction, percent, absolute token count via `maxTokens`), its
plausibility-band rejection (both an out-of-band percent and an
out-of-band token/maxTokens conversion), the one-time-warn latch, and
`contextPayload`'s `source: 'sdk' | 'fallback'` branching. The round trip
one layer up (`refreshContextUsage` calling the real SDK `getContextUsage()`,
and `usagePayload` forwarding its result) is still hand-verified only, per
the MVP4 note above - only the transform itself is unit-covered. Verified
by hand: `compactBtn`'s red state and tooltip, and `stats-panel.js`'s
context bar color, both track `context.autoCompact.warnPercent` instead of
the old independently-hardcoded 80/20/50 constants.

## Turn-chart y-axis scale

`turn-chart.test.mjs` covers the pure helpers behind the cost-graph axis
(`niceScaleMax`, `formatAxisTick` in `public/turn-chart.js`): rounding a raw
bar-max onto 1/2/2.5/5/10 (including fractional dollar amounts and
thousands of tokens), and compact `$` / `K` / `M` tick labels. The DOM
drawing (gridlines, left-side labels, metric switching) is client-side and
hand-verified only, same convention as the rest of `public/*.js`.

**Not covered by unit tests, hand-verified only:** that the axis tracks the
metric dropdown (cost vs tokens in/out/cached), that "exclude cache misses
from scale" still sets the labeled max, and that the viewport slider does
not rescale the axis (it is a transcript-scroll thumb, not a zoom).

## Message timestamps toggle

Entirely client-side (`public/settings.js`, `public/stream-view.js`,
`public/app.js`, `public/history-pane.js`) - hand-verified only, per the
"hand-verified only" convention above. Checked: the Settings checkbox
retroactively stamps/unstamps every message already on screen (a CSS class
toggle, not a re-render); a resumed live Claude session shows real
per-message clock times with the full date in the tooltip; a live Grok
session (no `timestamp` field on its messages) shows receive-time instead;
a past session opened via the resume list's "View" button shows real times
when the transcript has them and none when it doesn't (no fabricated "now"
on old messages); the setting persists across a reload.

## Copy-last-reply / export-session

`transcript-markdown.test.mjs` covers `src/transcript-markdown.js`'s
`messagesToMarkdown` directly: every message type (user text, assistant
text/thinking/tool_use, tool_result, a result error, an unknown type),
heading structure, the truncation marker, and fence-widening when content
already contains a run of backticks. `server-auth.test.mjs` covers the
`/api/history/:sessionId/markdown` route's content-type and
content-disposition headers and its graceful-empty behavior on an unknown
session id (same as the underlying SDK read - it doesn't throw, so neither
does this route).

**Not covered by unit tests, hand-verified only:** `#copyLastBtn`/
`#exportBtn` (`public/app.js`) and the history pane's export link
(`public/history-pane.js`). Verified via Playwright against this session's
own real transcript: the export link's href carries the right session
id/cwd/provider and downloading it returns real transcript content with
the correct headers; copy-last-reply reads the *last* `.msg.assistant
.body` node specifically (not the first) and writes its exact text to the
clipboard. Copy reads `dataset.rawText` when the body was markdown-rendered
(so block structure is not smashed by `textContent`), falling back to
`textContent` for non-markdown bodies.

## Markdown rendering (assistant replies)

`markdown.test.mjs` covers `public/markdown.js`'s `renderMarkdown` directly,
via a hand-rolled DOM stub (`tests/helpers/dom-stub.mjs` - this project
ships no jsdom dependency, so the stub implements just the handful of DOM
primitives markdown.js actually touches: createElement/createTextNode/
createDocumentFragment, textContent, append, classList.add, dataset,
style.textAlign). Covered: paragraphs and paragraph breaks, bold/italic/
inline-code (including nesting, e.g. bold containing code, and `***` as
bold+italic), links (target/rel set, GFM title stripped from href), image
markup as a labeled link (never `<img>`, no leftover `!`), fenced code
blocks (verbatim, no inline parsing inside, language in `data-lang`,
including tags like `c++` that are not just word chars, plus `~~~` tilde
fences that do not close a backtick fence), a fence opener with extra text
after the first token recovered as the first code line rather than a
language tag, ATX headings h1-h6, horizontal rules, blockquotes, flat
unordered/ordered lists, nested sub-lists under both list types, GFM
task-list checkboxes (checked and unchecked), GFM strikethrough, backslash-
escaped markers, word-boundary-only underscore italic/bold (so
`file_name_here` stays literal), GFM pipe tables (column alignment, escaped-pipe cells, and
that a bare pipe-containing line without a delimiter row stays a plain
paragraph instead of misfiring as a table), and the safety property the
module's own top comment calls out - text is built via textContent, never
innerHTML, so literal `<img onerror=...>`-shaped text renders as escaped
text, not markup, both in prose and inside inline code spans.

**Not covered by unit tests, hand-verified only:** the actual browser
integration in `stream-view.js` (that assistant text blocks and delegated
`/ask` replies get run through `renderMarkdown` and mounted under
`.markdown-body`; tool args/results/thinking/plain user messages do not)
and the CSS in `style.css` (`.markdown-body p`'s `white-space: pre-wrap`,
which is what makes multi-line paragraphs break visually - the renderer
itself just joins lines with `\n` and relies on that CSS, so a
soft-break-vs-hard-break distinction was deliberately not implemented; see
git history for the reasoning). Verified by hand: real streamed replies with tables, checklists,
and nested bullets render correctly in the app itself. `joinStreamText`
is a single shared module (`src/stream-join.js`, re-exported from
`grok-messages.js`, imported by `stream-view.js` as `/stream-join.js`);
`grok-messages.test.mjs` covers it, then re-rendered here. Also
covers a fenced directory listing streamed one row per chunk - those rows
are not markdown structure, so they used to flatten into one `<pre>` line.

## Persistent session title

`session-titles.test.mjs` covers `src/session-titles.js` directly:
`setSessionTitle`/`getSessionTitle` round-trip (with trimming and a
120-char cap), an empty/whitespace title deleting the entry rather than
storing `""`, sibling `sessionDefaults`/`enabledPlugins` keys surviving a
title write, a concurrency case interleaving `setSessionTitle` with
`setSessionDefaults`/`setPluginEnabled` on the same cwd (same shape as
`session-defaults.test.mjs`'s own), and `attachTitles`'s join logic in
isolation (matching session, no titles for that cwd, `cwd: null`, unknown
session id within a cwd that has other titles). `server-auth.test.mjs`
covers both new routes: `POST /api/sessions/:id/title`'s 401 (parametrized
alongside the other newer routes), 409 when `claudeSessionId` isn't known
yet, and its happy path persisting to `settings.local.json`; and
`POST /api/session-title`'s 400 on an invalid cwd and its happy path for a
past session with no live registry row.

**Not covered by unit tests, hand-verified only:** the resume list's rename
button and the live-session rename prompt (`public/app.js`). Verified via
Playwright against this session's own real transcript: renaming from the
resume list updates the primary line immediately, survives a full page
reload (confirmed both in the DOM and by reading the resulting
`settings.local.json` directly), and the original transcript-derived label
survives as the row's tooltip rather than being discarded.

## Permission always-allow, wider scope

`permission-rules.test.mjs` covers `src/permission-rules.js` directly:
`formatRule`'s bare-vs-parenthesized shapes, `addAllowRule`/`readAllowRules`
round-trip, dedupe on exact string match, `removeAllowRule` (including the
no-op case for an unknown rule), `permissions.deny`/`ask` and
`sessionDefaults` surviving a write, and a concurrency case interleaving
`addAllowRule` with `setSessionDefaults` on the same cwd (same shape as
`session-defaults.test.mjs`/`session-titles.test.mjs`'s own). `session.test.mjs`
extends the existing `canUseTool`/`resolveApproval` coverage for both new
scope strings (`'session'` and `'project'` both auto-allow in-session
immediately; the legacy boolean `true` still coerces to `'session'`; a
deny never carries a scope even if `alwaysAllow` were set; an unknown
requestId returns `false`). `server-auth.test.mjs` covers the route layer:
401 on the two new `permissions` routes (parametrized alongside the other
newer routes for `approval-decision`, plus dedicated GET/DELETE 401
coverage since the shared parametrized list is POST-only), 400 on an
invalid `alwaysAllow` value, 404 on an unknown approval requestId, and that
`alwaysAllow: 'project'` persists a rule to `settings.local.json` while
`'session'` does not.

**Not covered by unit tests, hand-verified only (partially):** the approval
banner's `<select>` and the Settings modal's revoke list
(`public/app.js`/`index.html`) - Playwright confirmed both render with the
correct structure (the select's three options, the rules-list container).
The full live flow (choosing "always in this project" on a real approval,
seeing it land in the Settings list, revoking it) is not hand-verified
live - reaching a real approval prompt requires a live CLI session
mid-tool-call, which isn't a quick manual pass - but every step of that
flow's server-side logic (scope persistence, the list GET, the revoke
DELETE) is exercised by the integration tests above against the real
`server.js` route dispatch, just with a stubbed session in place of a live
CLI process.

Root cause (found by an investigation agent, confirmed against the running
process and the CLI's own tool definition): `AskUserQuestion` is an ordinary
`canUseTool` round trip whose answer rides back as `updatedInput.answers`,
keyed by the *exact* question text - it isn't special-cased by the SDK at
all. Two bugs compounded: `AUTO_ALLOW_MODES` (acceptEdits, bypassPermissions,
etc.) auto-allowed it like any other tool, passing `input` straight back
unmodified - which the tool reads as an empty `answers`, i.e. "the user did
not answer the questions" - and even in `default`/`plan` mode, the client's
approval banner rendered a generic allow/deny with no questions or options
visible, so a click still sent no `updatedInput`. Net effect: calls either
parked forever (nothing ever resolved them) or resolved to an empty answer.

`session.test.mjs` covers the fix at the `canUseTool` layer: `AskUserQuestion`
always reaches `onApprovalRequest` regardless of mode (a new test drives this
under `acceptEdits` specifically, the mode most likely to have silently
swallowed it), while every other tool's auto-allow behavior is unchanged
(also directly tested, so the fix couldn't accidentally widen into "nothing
auto-allows anymore"). **Not covered by unit tests, hand-verified only:**
`public/app.js`'s `renderQuestionForm` (the actual question/option UI,
single- vs multi-select toggling, the free-text "Other" fallback, and that
`answers` is built keyed by exact question text) - same client-side tradeoff
as the rest of this app. Verify by hand: trigger a real `AskUserQuestion`
call and confirm the form renders with real options, an answer round-trips
correctly, and Skip denies cleanly instead of parking.

## MVP3 - reconnect, tab chrome

`event-log.test.mjs` covers `src/event-log.js` directly: seq assignment,
replay-from-seq, the byte-cap eviction, and the gap case (`sinceSeq` older
than what the log still holds - the caller gets a full resend instead of a
replay with a hole in it). `session-registry.test.mjs` covers the same
thing one layer up: `attachClient(id, ws, sinceSeq)` sends only the delta
on a reconnect, and a fresh attach still gets everything. `server-auth.test.mjs`
covers the new `GET /api/sessions/:id` route's auth (used by the client to
check a remembered session is still live before rejoining it) and its 404
on an unknown id.

**Not covered by unit tests, hand-verified only:** everything client-side -
`public/app.js`'s actual websocket reconnect-with-backoff loop,
`localStorage`-based rejoin-on-reload (`cockpit:activeSession`), and
`public/tab-chrome.js`'s title/favicon/needs-attention behavior. These need
a real browser (jsdom doesn't cover WebSocket/localStorage/document.hidden
convincingly enough to be worth the harness). Manually verified per the
plan's MVP3 Verification section: closing and reopening a tab mid-turn
rejoins the same session with no gap or duplicate messages; a killed
connection auto-reconnects with backoff and catches up; two tabs on one
session both render and either can send; an unfocused tab whose turn
finishes shows the needs-attention favicon/title, cleared on refocus.

**Not covered by unit tests:** `registry.rewind()` and `registry.loadEarlierHistory()`
(both call SDK functions - `forkSession`, `getSessionMessages` - imported
directly rather than dependency-injected like `startSessionImpl` is), and
the live `canUseTool`/plan-mode wiring in `src/session.js` itself. Both
were verified by hand against a real session while building MVP2 - see the
session.js comment above `canUseTool` for what was confirmed live (default
mode auto-denies with no callback configured; `acceptEdits`/`bypassPermissions`
resolve without ever calling the callback; every gated tool call routes
through it now, not just `ExitPlanMode`). `countWithinTokenBudget` (the
pure logic behind the resume tail) and `createSession`'s seeding *are*
covered - only the actual `getSessionMessages` fetch inside
`loadEarlierHistory` isn't. Worth a scripted regression test if this area
gets touched again.

The turn-index math `resolveTurnUuid` depends on **is** covered even though
`resolveTurnUuid` itself isn't: `isRealUserTurn`/`countRealUserTurns`
(`session-history.test.mjs`) is the shared definition of "what counts as a
turn" that both it and `session.js`'s `turnCounter` seeding must agree on,
and `createSession`'s `turnIndexOffset` threading is asserted directly
(`session-registry.test.mjs`). That was the actual bug (turnCounter reset
to 0 on every resume, drifting out of sync with the full-transcript index)
- the untested part now is only the `getSessionMessages` fetch plumbing
around it, same as `loadEarlierHistory`.

Two residual edges on the turn-index fix, known and accepted rather than
silently unhandled: a resumed session whose history fetch fails (network
blip, wrong cwd) is caught and flagged `turnIndexUnreliable` - `rewind()`
refuses to run on it rather than mistargeting, covered in
`session-registry.test.mjs`. A `/clear` mid-session resets `turnCounter`
in `session.js` on the SDK's `conversation_reset` message - covered now in
`session.test.mjs` (added the `queryImpl` injection point specifically for
this). What that test does **not** verify - because it's a property of the
real SDK's transcript storage, not of this code - is whether
`resolveTurnUuid`'s `getSessionMessages` read is itself scoped to the
post-clear conversation or still spans pre-clear history too; see the
comment in `session.js` for what's actually unverified there. Worth a
manual check against a real session if rewind-after-`/clear` matters in
practice.

`integration.manual.mjs` is **not** part of `npm test`. It spawns a real
Haiku session through the actual Claude Agent SDK, so it costs a few cents
and takes ~10-20s. Run it by hand after touching `src/session.js`:

```
node tests/integration.manual.mjs
```

It's the regression test for the streaming-input priming-sentinel fix (see
the comment in `src/session.js`): without it, `system/init` never arrives
when `query()` is fed an `AsyncIterable` prompt, and the session hangs
forever. It also checks the compose box's most interesting failure mode
per the plan's Verification section - sending a second message while the
first turn is still running queues it rather than dropping or interleaving it.

## Process ownership, shutdown, and orphan reaping

**Run the suite as `node --test tests/`.** Node 20's `--test` has no glob
support, so `package.json`'s `node --test tests/*.test.mjs` only works where
the *shell* expands the glob (bash/zsh) - in PowerShell or cmd it is passed
through literally and the runner finds nothing. Naming the directory works
everywhere; it also picks up `*.test.mjs` only, so the `*.manual.mjs` files
stay excluded either way. **Never run a `*.manual.mjs` file to "check the
suite"** - several spawn real, paid CLI sessions.

Four files cover this feature, and the split between them is deliberate:

- `json-store.test.mjs` - the atomic write/queue helper. `updateJson` mutates
  in place and refuses a corrupt file; `replaceJson` returns the value to
  write and replaces one (that is `runtime.json`, where refusing would mean
  silently not recording PIDs). Also pins the two properties `child-tracker`
  leans on: writes land in call order, and awaiting one is a full flush of
  everything queued before it.
- `child-tracker.test.mjs` - the registry, ref-counting for Codex's shared
  app-server, start-time tolerance, the four `verifyEntry` verdicts, the
  owner discriminator, and refuse-to-kill-when-unverifiable. Every probe and
  kill is injected, so nothing is spawned and nothing is killed.
- `shutdown.test.mjs` - ordering, idempotence, the grace period, and one bad
  hook not stranding the CLIs, all against fakes.
- `shutdown-integration.test.mjs` - the seam between the three. This one
  exists because every critical found in the final review of this feature was
  invisible to the three files above: they fake each other's boundaries, and
  `shutdown.test.mjs` in particular models `tracker.list()` as independent of
  `registry.closeSession()` when in production closing a session was exactly
  what emptied the tracker. It drives the **real** registry, tracker, Codex
  app-server manager and shutdown against bare `process.execPath -e
  'setInterval(...)'` children, and asserts the properties those bugs broke:
  a survivor of the grace period is really killed, `runtime.json` really ends
  `[]`, a child that dies on its own releases its entry, and an entry owned by
  a still-live cockpit PID is left alone. The kill is the real OS kill
  (`taskkill /t /f` on Windows, `process.kill` elsewhere) - the point is that
  the process is gone, not that a stub was called. No provider CLI, no
  network, no cost. Only the OS start-time probe is injected, since the real
  one shells out to PowerShell/`ps` and nothing here is testing PowerShell.

**Not covered by unit tests, hand-verified only** - all three are the parts
that cannot be faked without testing the fake instead:

- **The real Ctrl-C path.** `process.stdin.setRawMode(true)` means the OS
  never delivers `SIGINT`, so the TTY keypress handler in `server.js` is the
  only Ctrl-C the process sees. Verify by hand: `npm start`, open a Grok
  session and send one message, note the pid in
  `~/.prompt-cockpit/runtime.json`, press Ctrl-C. Expect `shutting down
  (keypress-ctrl-c)…`, a terminal that still echoes (that is
  `setRawMode(false)`), `Get-Process -Id <pid>` finding nothing, and
  `runtime.json` back to `[]`. Repeat with one Codex session, and with two
  Codex sessions open (one shared app-server pid, killed once). Repeat once
  more pressing Ctrl-C twice, which must exit immediately rather than wait.
- **The real `taskkill` tree-kill.** Only `shutdown-integration.test.mjs`
  exercises the actual kill, and only against a plain node child - not
  against a Windows `.cmd` shim with a grandchild under it, which is the case
  `/t` exists for. Verify by hand whenever the Grok or Codex launcher changes
  how it resolves a binary.
- **The real PowerShell/`ps` start-time probe.** Its output parsing (`Date.parse`
  over `Get-Process | StartTime.ToUniversalTime().ToString('o')` and over `ps
  -o lstart=`) is fake-driven in every test, because a real probe makes the
  suite spawn a shell and vary by OS. The 3s tolerance exists precisely
  because those two formats round differently, so re-check it by hand after
  `taskkill /f`-ing a cockpit: the next start must either reap the orphaned
  CLI or log a refusal naming the pid. A silent no-op means the probe is
  returning something `Date.parse` cannot read.

## Superagent core (Plan 2)

`src/superagent/` is a library (wired into `src/server.js` by Plan 6, below); the `author`, `brainstorm`, `review`, `per-task` and `human` phase kinds run (the `milestone-1` and `milestone-2` fixtures, and since Plan 5 the default pipeline, which starts with the brainstorm). One test file per module:

| Module | Test file |
|---|---|
| `config.js` | `superagent-config.test.mjs` |
| `store.js` (`events.jsonl` truth, `state.json` cache) | `superagent-store.test.mjs` |
| `worktree.js` | `superagent-worktree.test.mjs` |
| `results.js` (attempt results, validation) | `superagent-results.test.mjs` |
| `prompts.js` (role templates, job card, prompt-surface test) | `superagent-prompts.test.mjs` |
| `sequencer.js` | `superagent-sequencer.test.mjs` |
| `runner.js` | `superagent-runner.test.mjs` |
| `index.js` (`createSuperagent`) | `superagent.test.mjs` |
| `milestone-2` pipeline end to end (Plan 3), the default pipeline's brainstorm and answered questions (Plan 5) | `superagent-pipeline.test.mjs` |

The runner and end-to-end tests use the real `session-registry.js` with one `fakeStartSession` per session (`sessionFactory` in `superagent-helpers.mjs`, which spreads the real registry and overrides only `createSession`) and real `git` in temp repos. No model, no network, no cost.

`superagent-pipeline.test.mjs` drives `createSuperagent` with `tick()` and `scriptedWorker` (`superagent-helpers.mjs`): a fake worker that reads the job card from a session's first `sendInput`, runs a per-purpose handler that commits real files in the job's worktrees, and publishes `result.json`. Only the happy path runs every phase with workers; the other `milestone-2` scenarios fast-forward the earlier phases through the store and run just the loop under test, and the Plan 5 scenarios run the default pipeline from its brainstorm with workers. About 80s, nearly all of it git process spawns. `initRepo` sets `core.fsmonitor false`, because a machine-wide `core.fsmonitor=true` leaves one daemon running per temp repo.

**Not covered by unit tests, hand-verified only (not yet run):** all three are observed by `tests/superagent-two-phase.manual.mjs`, which needs the user's approval to run (floor estimate about $0.50; Plan 1's probes cost 10-30x their header estimates).

- **Real `auto`-mode behaviour.** Whether the SDK calls `canUseTool` for an ordinary tool such as Bash when a worker runs in `auto` with `sdkOptions.interceptEveryPermission`. `src/session.js` says it skips it; spike S1 saw it only for `AskUserQuestion`. Until observed, the unattended-denial path is proven only against the fake. **Resolved by the 2026-11-04 probe run: the SDK skipped canUseTool for Bash in auto; commits succeed and the deny rule does not constrain ordinary tools.**
- **`maxTurns` semantics.** Whether it counts per prompt or per session in streaming input, and the real `error_max_turns` subtype.
- **PreCompact through `sdkOptions.hooks`.** Whether a real firing reaches `events.jsonl` as a `precompact` line.

Not built (as of Plan 5: the router, the automatic brainstorm and `answerQuestion` now exist, see below): manual mode, usage ledger and caps, UI, server wiring, worktree removal.

## Superagent pipeline (Plan 3)

Unit and integration tested (no model, no network):

- `superagent-pipeline.test.mjs` scenarios: the `milestone-2` happy path (spec to accept with two dependent tasks), a contested blocker reaching the verifier (`verified:false` proceeds as disputed-not-verified; confirmed parks `needs-you` with the evidence), the task review loop (changes, fix, approve; the verifier path at `taskReviewRounds`), and test-failure routing into fix tasks.
- Results validator rules (`superagent-results.test.mjs`): review verdict/findings and dispositions, `tasks.json` shape (ids of at most 12 characters, no deadlocking dependencies), per-purpose required outputs, implement report and commit evidence.
- Sequencer loop rules (`superagent-sequencer.test.mjs`): review loop rounds and the failed-attempt cap, final-pass blocker rule, per-task launch order, test routing.

Only observed by the manual probe `tests/superagent-pipeline.manual.mjs` (not yet run; no cost cap beyond a 40-minute deadline and the attempt limits; every role runs Sonnet 5.5 (the installed SDK's bundled Claude Code rejects claude-opus-5-5, so the probe overrides the Opus roles; PROBE_KEEP_MODELS=1 skips that); maxRounds stays at the fixture default of 3 review rounds per review phase because config cannot override it):

- Whether real reviewers produce a parseable verdict/findings with the dispositions the validator wants.
- Whether real planners produce a valid `tasks.json` with ids of at most 12 characters.
- Whether the real implementer reports the `verify` check.
- Whether `auto` mode lets workers commit in every phase.
- How long a full pipeline takes.

## Superagent router (Plan 4)

Unit tested (no model, no network; the router's `query` is always injected):

- `superagent-router.test.mjs` (`router.js`): the pure parts (`estimateTokens`, `allowedActions`, `buildRouterRequest` with its truncation order and over-limit refusal, `validateRouterOutput` including the output cap and missing usage) and `createRouter().decide` against a fake `query` (isolation options, `apiKeyHelper` passthrough, the settings `env` block merged into the spawn env, allowlist, timeout, abort, isolation-breach guard, usage totals).
- Sequencer routing (`superagent-sequencer.test.mjs`): the `route` action for eligible failures after the attempt cap, repeated-error and back-off checks, and applying a `router-decided` decision (`retry`, `retry-alternate`, `retry-handoff`, `escalate`, stuck why `router-escalated` / `router-failed`).
- Supervisor routing (`superagent-pipeline.test.mjs`): non-blocking per-job routing, per-job cancellation on `stopJob`/`stop`, confirmed decision appends with retry and no second model call, and no router injected keeps the code-only retries.

Only observed by the manual probes (not yet run; they spend real money):

- `tests/superagent-router.manual.mjs` makes three real Haiku calls through `createRouter().decide`: a worst-case ASCII card, the same in CJK, and a 50-token output cap. It checks that the real total input stays at or below the pre-send estimate and under 6000, and whether `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is honoured (unverified at SDK 0.3.318; the post-call check stays either way).
- `tests/superagent-pipeline.manual.mjs` now injects `createRouter()` and prints each `router-decided` (action, note, estimated vs real input tokens, latency), which shows whether a real router picks sensible actions in a full job.

Why manual: the real SDK call, the CLI's auth and the real tokenizer are not injectable. The notification-text router call is not built.

### Router after the 2026-11-05 probe (final fix wave)

The first real run of `superagent-router.manual.mjs` failed; its findings are in `.superpowers/sdd/2026-11-05-superagent-p4-router/router-probe-findings.md`. What changed, and where it is tested:

- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is a hard API max, not a soft cap: a reply over it fails the call ("exceeded the N output token maximum"). Haiku 5.5 thinks on every call and thinking counts as output, so the env cap is now `routerMaxOutputTokens + ROUTER_THINKING_ALLOWANCE` (1000), and `routerMaxOutputTokens` (at most 4000, `superagent-config.test.mjs`) limits the ANSWER: `result.usage.output_tokens` less `output_tokens_details.thinking_tokens`, checked after the call (`superagent-router.test.mjs`).
- `usage` keeps the router's own request (`requestInputTokens`, `requestOutputTokens`, `thinkingTokens`, from `result.usage`) apart from the spend (`inputTokens`, `outputTokens`, cache fields, `totalInputTokens`, `costUsd`, from `modelUsage[model]`, which folds in a hidden ~2,951-token request). The router probe's gate is on request input: `usage.requestInputTokens <= estimatedTokens <= 6000`.
- Fail-closed additions in `superagent-router.test.mjs`: a non-positive-integer `maxOutputTokens` (`bad-limit: maxOutputTokens`, no call), a result before any `system/init` or an init without its `tools` / `mcp_servers` / `plugins` list (`isolation-breach`), character caps for space-free text (cards and the 300-character note limit).
- `superagent-pipeline.test.mjs`: an `aborted` error the supervisor did not cause is recorded as a router failure, and the trigger's `model` is the failed attempt's own model. `superagent-sequencer.test.mjs`: the per-task cap and a review scope's repeated error win over routing.
- The router probe now makes four calls; the fourth (`thinkingAllowance: 0`) shows the API failing at a 50-token env cap. Both new informational calls still never fail the run.

## Superagent brainstorm and answers (Plan 5)

Unit and integration tested (no model, no network; scripted workers):

- `superagent-config.test.mjs`: the default pipeline's first phase has kind `brainstorm` (first and unique, with a `stand-in` model), and `limits.questionsPerScope` defaults to 3.
- `superagent-store.test.mjs`: `question-answered` sets the job running again only when it answers the open question, and replays the same way; `attempt-ended` keeps `questions`, `answers`, `escalated` and `tokens`; the brainstorm phase advances only on an `ask` with no questions.
- `superagent-results.test.mjs`: the `ask` and `answer` schemas (at most 5 new questions, a final ask may not ask, the stand-in answers exactly the open questions or escalates one), the brief and spec headings check, and the `-r<round>` verifier paths of an extra round.
- `superagent-prompts.test.mjs`: card fields `exchanges`, `openQuestions`, `maxQuestions`, `resultVia` and `userAnswers` (scoped to the asking phase or task), a phase review's `previousResponse` (the previous round's response, or its own round's in an extra round), the `brainstormer.md` and `stand-in.md` templates, and the contract's `ask`/`answer` carve-outs.
- `superagent-sequencer.test.mjs`: the brainstorm turns (`brainstormAction`, the exchange and token caps), `brainstormLog`, the stand-in escalation detail, an interrupted stand-in relaunching on the same batch, answered questions relaunching their scope without consuming the attempt cap, the question cap (its detail names the tripping `attemptId` and `question`), and the extra review round after an answered confirmed blocker with its carried findings.
- `superagent-runner.test.mjs`: every ask is denied, the brainstormer's included; the stand-in launches with `tools`/`disallowedTools`, and its final message is parsed and materialised as `result.json` on the first scan (with the documented loss window when the row goes before any scan); `tokens` from the row's usage totals.
- `superagent-pipeline.test.mjs`: on the default pipeline, the automatic brainstorm reaching `spec` with the brief; a stand-in escalation answered with `answerQuestion` and resumed, also across a supervisor restart; `answerQuestion`'s refusals (wrong state, a budget question, a repeat, bad text, an unknown job) with `events.jsonl` unchanged; an answered spec question; the fourth question in a scope stuck as `question-cap`; and a dismissed verifier-confirmed blocker closing after the extra round (a project config sets spec-review `maxRounds: 1`, since the `milestone-2` fixture is frozen at 3).
- `superagent.test.mjs`: `createJob({ mode: 'manual' })` refused with `ERR_MODE_UNSUPPORTED` on a pipeline with a brainstorm, and accepted on `milestone-1`.

A dismissed blocker on a task whose `repos` exclude `primary` still needs a commit in a task repo plus the `verify` check (Plan 3's task-fix evidence rule), so a "leave it" answer may force a token commit.

Hand-verified only (not yet probed; the user deferred every probe to the end of the plans): whether the real SDK honours the stand-in's `tools: ['Read', 'Grep', 'Glob']` and `disallowedTools: ['mcp__*']`, and whether a real stand-in returns a parseable result as its final message. Both are proven only against `fakeStartSession`.

Token counts are an under-count only for attempts finished by reconcile after a restart (`tokens: null`, counted as 0); a removed attempt records the last scanned snapshot of its row.

## Superagent view (Plan 6)

Unit-tested (all in `npm test`, no network, no real session):

- `superagent-owner-lock.test.mjs`: first acquire, a live owner refused, a dead owner taken over, simultaneous acquire and simultaneous stale takeover each with exactly one winner, the put-back of a fresh lock moved by mistake, a claim emptied after a successful rename, a rename refused while racing an unlink (retried once), a failed identity write publishing nothing, leftover `*.tmp`/`*.claim` files ignored, an unparseable lock occupied, and release removing only our own lock. The races run against an injected fs; they are interleavings, not real parallel processes. The three-contender and mid-takeover-error residuals in the file header are not tested (see `backlog.md`).
- `superagent-host.test.mjs`: the host lifecycle (off, init loading config before the supervisor, `error` on a corrupt config, `not-owner` with and without a port, router on only with an `apiKeyHelper`), `admit`/`read`, `stop()` blocking launches and waiting for admitted actions, the shared 2500 ms `stop()`/`afterClose()` budget, shutdown during initialisation, a supervisor that fails to start, the real default factories under a temp root (including the default supervisor reading global workflows from `<root>/workflows`), `notificationsReady()` false while off, initialising, waiting on `supervisor.start()`, `not-owner`, `error` and stopped, and true once `start()` has resolved (ready, and stopping after that), and `wireSuperagent` registering both hooks before init.
- `superagent-routes.test.mjs`: `GET /api/superagent` and job detail, job creation (defaults, a missing folder, coded errors as 400), a repeated answer as 409, an answer without a `needsYouSeq` as 400 and a stale one as 409, accept and stop, an unavailable host, the artifact route's error mapping and the merged `/api/notifications` (with `superagentReady`, and one throwing source logged while the other is still served). `superagent.test.mjs` checks that `answerQuestion`/`accept` with a stale `needsYouSeq` append nothing. `autopilot-routes.test.mjs` checks the server's real `/api/notifications` body. `ERR_DUPLICATE_REPO` is covered here and in `superagent.test.mjs`.
- `watch-only.test.mjs`: every mutating session action, `DELETE /api/sessions/:id` and the ws input types refused for a superagent worker session (token checked first), reads and other sessions unaffected, and attach-token reporting `watchOnly`.
- `superagent-view-model.test.mjs`, `superagent-artifacts.test.mjs`: the pure job summary, phase chips, attempt caps, `needsYou.answerable`, notification entries and keys, a corrupt job summarised without throwing, and `readArtifact` including real-path containment (a linked file or parent directory pointing outside is refused, large files truncated). The file-symlink case skips on Windows without symlink privilege (the 1 skipped test).
- `notify-dedupe.test.mjs`: first poll records without notifying, one notification per new entry, two tabs' overlapping claims notifying once (Web Lock) and the tag-only fallback without locks, storage errors, `keep` preserving `superagent:` keys across a restart (ready with a key, a not-ready poll without it, ready again: not re-notified, while a non-superagent entry is still claimed), and the module being served to the browser verbatim.

Hand-verified only. There is no jsdom, so `public/superagent-view.js`, `entry.js` and `notifications-panel.js` have no automated coverage. Task 11's Playwright run against a Cockpit on a temp `COCKPIT_HOME` (seeded by `tests/superagent-view-fixture.manual.mjs`, which proves with a fake registry that nothing launches and exits non-zero otherwise) verified: status states, refused-folder errors (not a repo, no commits, duplicate repo, missing folder, path too long), the three panes, the artifact viewer, the bell and badge, an `<img onerror>` question rendered as text only, Accept, Stop, a second tab's stale Accept giving a 409, one browser notification per new entry across two tabs, and reload.

Final fix wave, same setup (temp `COCKPIT_HOME`, `CLAUDE_CONFIG_DIR` empty so the router was off, port 4399, fixture's NO-LAUNCH CHECK PASSED first, server stopped after; no answer sent, no job created): a bell entry clicked in a regular tab, and in the Superagent tab itself, selected the job in the existing Superagent tab without reloading it (a `window` marker survived, no third tab) and kept both a typed New job idea and a typed answer draft; `superagentReady: true` from the real server; a stale and a missing `needsYouSeq` answered 409 and 400 by curl with `events.jsonl` unchanged; with `/api/notifications` routed to `superagentReady: false` in both tabs the `cockpit:notifiedKeys` record kept all three keys, and the next ready poll with one extra key showed exactly one (stubbed) notification; and the fixture with a corrupt `config.json` printed the DO NOT START banner and exited 1. Not verified: whether the browser actually raises the found Superagent tab on `focus()`.

Plan 7 Task 9, same setup (the fixture now also seeds a Troubleshooting job at `ready-to-try`, an in-place Feature job paused at `folder-changed` on `<repoDir>-inplace`, and an invalid global `workflows/broken.json`; NO-LAUNCH CHECK PASSED over the six jobs first): the Workflow select listing Feature, Troubleshooting and the broken file disabled with its first error on hover and below; a primary folder with a project workflow adding it on refetch while keeping a still-valid selection; an invalid project `feature` override as the default leaving "Choose a workflow" selected (submit blocked) with the default's first error shown; `defaultNote` from a `config.json` naming an unknown workflow (needs a restart: the config is read at boot); the in-place checkbox and note on the primary and an added folder, and the request body's `inPlace`/`workflow` (captured by a page-level `fetch` stub, not sent); an in-place create on a dirty temp folder refused inline with `ERR_FOLDER_DIRTY`, with the folder's status, HEAD, branches and exclude file unchanged (since 2026-11-18 a dirty folder is admitted with its paths recorded as `pendingChanges`, so this refusal is no longer reachable from the view and was not re-verified); the workflow name in the job list and detail; the Troubleshooting job's Ready to try showing `testReport` (no brief block) while the Plan 6 job still shows Test report and assumptions; the paused job shown as `paused`, its folder-changed text in a non-terminal Paused box, its `in place` marker, and its gated attempts labelled "paused before launch"; and, after stopping that job, "This folder is still on the job's branch.". `superagent-view-model.test.mjs` covers `pausedBeforeLaunch` and gated attempts listing no artifacts.

Plan 7 final fix wave, NOT hand-verified (no browser was run): Create refusing with `Wait for the workflow list to load.` while the list is loading or was listed for another folder (it then starts the fetch), and with `The workflow list could not be loaded; pick the primary folder again to retry.` after a failed fetch, and the last settled workflow choice surviving rapid primary-folder changes.

Task 10, watch-only: the `Superagent worker — watch only` banner and the hidden controls were checked with Playwright against a mocked session (`GET /api/sessions/:id` and the WebSocket faked through `page.route`/`page.routeWebSocket`), not against a real worker session.

Stubbed only (a faked `/api/superagent` or `window.Notification`): the initialising/stopping/off copy, a budget question, a denied permission, and an inherited saved session in the opener.

Not verified: the real OS permission prompt, an OS-level notification click, the **open** link for a live attempt, a corrupt-job row in the view, the narrow (900 px or less) layout, and rejoining a real live session after a reload. No real-model run was made for the view.

If you set `COCKPIT_HOME` for the fixture or a real run on Windows, keep it short: a long path makes every job fail with `ERR_PATH_TOO_LONG`.

## Superagent workflows and in-place folders (Plan 7)

Unit-tested (all in `npm test`, no network, no real model; temp `COCKPIT_HOME`, temp repos through `initRepo`):

- `superagent-workflows.test.mjs`: the validator's refusing cases (format, id pattern and the reserved `config-pipeline`, phase and artifact rules, reserved namespaces, review producers, `test` placement, one per-task/brainstorm/test phase, last phase `human`), the shipped `feature` file producing today's default pipeline and `troubleshooting` being valid, the loader's three sources and precedence, same-source duplicates, case-insensitive ids (a project `Feature` overriding `feature`, `fix`/`Fix` as duplicates, `Config-Pipeline` reserved, a configured default in another case), an unreadable workflows folder (injected `EACCES`) listed as one invalid entry, unparseable files, an invalid override shadowing a lower one, default selection by scope with the `defaultNote` fallback, `config-pipeline` appearing only for a raw `pipeline`, `resolvePromptPath`'s lookup order and the four-layer model merge.
- `superagent-store.test.mjs`, `superagent-results.test.mjs`, `superagent-sequencer.test.mjs`, `superagent-view-model.test.mjs`: phase-property keying (`test: true` routing, per-job `artifactPaths`, the brief-heading rule on the first brief-consuming author phase), a real pre-Plan-7 event log replayed through `deriveJob` as `feature`, `folder-changed`/`folder-restored` replay, gated attempts left out of counts and artifacts.
- `superagent-prompts.test.mjs`, `superagent-runner.test.mjs`: the deny message following the `brainstorm` kind; an in-place repo carrying `inPlace: true` on the card, the contract's in-place rule and no role prompt implying a tree-wide cleanup; a vanished recorded prompt ending `stuck` with `prompt-missing`; the gate before every launch (the tasks.json read included) and uncommitted changes not tripping it.
- `superagent-inplace.test.mjs`: each check's code with the folder left unchanged, `provisionInPlace` (same HEAD, no `.gitignore`, clean status, exclude line with a newline boundary, `check-ignore` failing on a nested negation), the recheck before the switch, `checkGate`, a paused folder refreshed once when it comes back with a different problem, the folder reservation (overlapping creates, rebuild at start, worktree origins coexisting), orphan listing skipping in-place repos, and the path-length check from the folder.
- `superagent-stop-provisioning.test.mjs`, `superagent-worktree.test.mjs`: Stop during provisioning. `createGit`'s abort kills the git process tree (an injected `killTree`, and once against a real hanging `git hash-object --stdin`), an already-aborted signal spawns nothing, an abort after git has exited kills nothing (its pid may be reused), and `removeAbortedWorktree` (a locked half-made worktree and its branch removed, a branch past `baseSha` kept, an unregistered leftover folder deleted, never a `git worktree prune`, nothing outside the worktrees root by path or junction, a junction to a sibling job's worktree refused, a throwing git turned into notes). Through `createSuperagent`: Stop during `worktree add` kills, cleans up without a prune and records `job-stopped` with no session and the reservation released, a cleanup failure is only logged, a stop between repos keeps the finished worktree and skips the next in-place repo, and a stop during an in-place `switch -c` waits for it, runs nothing in the folder and archives the ledger as any stop does. The `Stopping…` label and the provisioning wording of the Stop confirm are not tested (no DOM tests here) and have not been hand-verified.
- `superagent.test.mjs`, `superagent-pipeline.test.mjs`: `createJob` with a workflow and `inPlace`, a scripted-worker run of troubleshooting with one routed failure back into fix, an in-place job pausing and resuming on its own, and an edited workflow file not changing an existing job after a restart.
- `superagent-routes.test.mjs`: `GET /api/superagent/workflows` (project source, invalid files, `defaultNote`), create with `workflow` and `inPlace`, and the new error codes.

Hand-verified only. Troubleshooting's prompts were never run against a real model, and nothing in this plan launches one. Task 9 (the view) was checked with Playwright on a temp `COCKPIT_HOME` seeded by `tests/superagent-view-fixture.manual.mjs` (NO-LAUNCH CHECK first), as recorded under "Superagent view (Plan 6)" above. The narrow (900 px or less) layout was not verified, and a successful create was deliberately never made, since it would launch a paid worker. Large-repo behaviour of in-place provisioning (a double full `git status`, post-checkout hooks, `index.lock`) was not exercised.

## Superagent Retry on a stuck job and the router's settings env (2026-11-18)

Unit-tested (all in `npm test`, no network, no real model):

- `superagent-sequencer.test.mjs`: `job-retried` on an attempt-capped phase marks its failed attempts `retried`, empties `attemptsFor`, and the next launch is n 1 with `recovery: true`, the stuck attempt as `previousAttemptId`, the retry's `handoff` and `retryNote`; the retry is consumed by the next `attempt-started` in the scope, after which back-off and numbering are ordinary again; a retry after `repeated-error` or a router verdict launches without consulting the router; `job-retried` is ignored unless the job is `stuck`, and a per-task retry forgets only its own task's attempts.
- `superagent.test.mjs`: `retryJob` refuses a running job, a stale `needsYouSeq`, a non-text or over-4000-character note, and a second retry of the same entry, all without appending; it records the last attempt's `handoff.md` only when the file exists, and a blank note as `null`.
- `superagent-routes.test.mjs`: `POST .../retry` requires an integer `needsYouSeq` (400 `ERR_INVALID_REQUEST`) and maps `ERR_INVALID_STATE` to 409 and `ERR_INVALID_ANSWER` to 400.
- `superagent-runner.test.mjs`, `superagent-prompts.test.mjs`, `superagent-view-model.test.mjs`: `retryNote` on `attempt-started` and the attempt, on the card only when given, the contract explaining it; `needsYou.retryable` only for `stuck`; `attempts[].retried`.
- `superagent-router.test.mjs`: the `~/.claude/settings.json` `env` block (string values only) merged into the router's spawn env over the process env, under its own `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.

Hand-verified: the Retry button and note box were clicked with Playwright on a temp `COCKPIT_HOME` seeded by `tests/superagent-view-fixture.manual.mjs` (its stuck "Rename settings" job), with `CLAUDE_CONFIG_DIR` pointing at an empty folder so the launched worker was "Not logged in" (0 output tokens). The job went `running`, the three old spec attempts showed "retried, not counted", and attempt n 1 started with `recovery: true`, the stuck attempt as `previousAttemptId` and the note on its card. The fixture's attempts have no `dir`, so `previousAttemptDir` and a real `handoff.md` were not exercised there. The router fix was verified with real Haiku calls: with the gateway variables removed from the environment the call timed out at 90 s before the fix and returned in 3.2 s after it.

## Superagent view UX, spend, inspect and retrospective (2026-11-19)

Unit-tested (all in `npm test`, no network, no real model):

- `superagent-transcripts.test.mjs`: finding an attempt's transcript by its job card (found, missing, ambiguous, fallback scan with the transcript's own `cwd`), usage deduped by `message.id`, `anthropic.`-prefixed model ids priced as the bare id and sharing its By-model row, zero-token `<synthetic>` rows left out, unpriced models and truncation marking the result incomplete, the fingerprint changing when a subagent file is added or deleted while the match is reused, `verify`, and every stream opened being destroyed.
- `superagent-accounting.test.mjs`: the queue's provisional to final states, final-unknown after repeated misses, a pruned history keeping its final spend, the abort and shutdown rules (a stalled item cannot write after its budget or after `stop`, `stop` uses the caller's absolute deadline), snapshots independent of usage, a failed copy retried, and the latest writer winning when an older writer's copy is retried last.
- `superagent-artifacts.test.mjs`, `superagent-view-model.test.mjs`, `superagent-routes.test.mjs`: `artifactStates` (workspace, snapshot, gone, pending; `gone` only for a writer that ended `done`), `artifactWriters` attribution, `jobDetail` money as `{ usd, complete }` (mixed priced and unpriced, all unpriced, genuine zero, two router models), the transcript route's 200/404/409 and the host gate, and the Retrospective route with a fake registry and fake supervisor (selector validation, name collision picking `#2`, a send failure closing the session, the exact `additionalDirectories`, with only worktree job folders exempt from the forbidden roots and an in-place folder inside or containing one dropped, the clone search's excluded roots, the operator-token boundary).
- `superagent-retrospective.test.mjs`: plugin reference extraction, remote normalisation, dev-clone resolution (including its deadline, directory cap and excluded roots, each cut short to the ask-the-operator line), snapshot contents, `grantedDirectories` (junction, a forbidden root itself, a folder containing one, a similar-prefix sibling, the snapshot and job-folder exceptions, a missing path) and the first prompt. The file-symlink snapshot guard test is skipped on Windows without symlink privilege.
- `markdown.test.mjs`, `superagent-format.test.mjs`, `superagent-job-pane.test.mjs`, `superagent-handoff.test.mjs`: link chips and bare-URL autolinking (default rendering unchanged, a balanced closing parenthesis kept), the formatters, the job pane against the DOM stub (timeline, attempt expansion and its survival across a changed re-render, money texts, artifact chips, `renderArtifactBody`, Inspect enabled and disabled, the router decision cards), and both sides of the handoff with separate storage objects (ack only after read-back, foreign origin or window ignored, blocked popup keeps one session, the 10 s no-ack timeout, `handoff-failed`, reopen without a second POST).

Hand-verified only, or not verified:

- Layout, colours, attempt expansion and scroll persistence across a real poll were checked in a browser on a seeded temp `COCKPIT_HOME` at 1920 and 900 px.
- The router decision cards have only the DOM-stub test; they were never checked in a browser.
- Inspect of a finished attempt was checked only with Playwright route mocks. The real transcript index and the history route against real transcripts were not exercised together.
- The Retrospective route end to end (snapshot, grants, a real `sendInput`) is covered with a fake registry only and was never run against a model: no paid run was made, so the retrospective prompt has never been seen by a real session.
- The handoff's 10 s no-ack timeout is unit-tested only. The normal handoff, a blocked popup then Open (no second POST) and the inline error were checked in a real browser with the POST intercepted.
- `inspect()` in `public/superagent-view.js` has no client test.

Follow-up (2026-11-20): workflow emoji, folded stage groups, Spend last, resizable panes, artifact Download.

- Unit-tested: `workflowLabel` (`superagent-format.test.mjs`); stage groups folded by default, a click opening one and it staying open across a poll but not onto another job, `stageState`, Spend as the last card, and `artifactFileName`/`artifactMimeType` (`superagent-job-pane.test.mjs`); `readPaneWidths`'s defaults and bad stored values (`superagent-panes.test.mjs`).
- Hand-verified only, in a browser on a seeded temp `COCKPIT_HOME` at 2000 and 800 px: the middle/right even split before any drag, a drag of the middle splitter resizing the panes and persisting `cockpit:superagentPaneWidths`, the splitters hidden in the narrow layout, and Download saving a snapshot artifact byte-identical to its stored copy (and disabled for a gone one). The splitters' keyboard and double-click reset, and a truncated (over 1 MB) artifact's disabled Download, were not exercised.

Rename (2026-11-20):

- Unit-tested: `job-renamed` in `deriveJob` and `store.append` (title only, slug and branch kept, an empty title ignored; `superagent-store.test.mjs`), `renameJob` (empty, over 200 characters, non-text and unknown job refused with nothing appended, trimmed, a same-title rename appending nothing, a stopped job renamed; `superagent.test.mjs`), the route (non-text title refused before the supervisor, 400 and 404 mapped; `superagent-routes.test.mjs`) and the pane's Rename button (`superagent-job-pane.test.mjs`).
- Hand-verified only, in a browser on a seeded temp `COCKPIT_HOME`: the dialog prefilled with the current title, a blank title showing the 400 inline with the dialog left open, Enter saving, the pane title and job list updating, the branch unchanged, and the `job-renamed` line in `events.jsonl`. A renamed title reaching a later worker's job card was not run against a real worker.

Artifacts out of git, tests not committed (2026-11-24):

- Unit-tested (all in `npm test`): `ledgerArtifactRoot` and the ledger-prefixed `deriveJob` artifacts (`superagent-store.test.mjs`, `superagent-results.test.mjs`); validation of a ledger job without artifact commits, `outputs` hashes, `commitPathErrors` (`commit includes superagent files: <path>`, `commit includes test files: <path>` only when `commitTests` is false, non-ASCII paths) and `branchPathErrors` (unlisted commits on the job branch, named by sha, merges against their first parent, a rewritten commit passing, each commit reported once) and the lib-only-task evidence rule (`superagent-results.test.mjs`); reserved paths `.git/`, `.superpowers/`, `reviews/`, `tasks/` (`superagent-workflows.test.mjs`); `commitTests`/`testPaths` defaults, validation and precedence (`superagent-config.test.mjs`), `isTestPath` including case-sensitivity and `.meta` (`superagent-test-paths.test.mjs`), the route's `commitTests must be true or false` (`superagent-routes.test.mjs`), a scripted troubleshooting job leaving only code on the branch (`superagent.test.mjs`, `superagent-pipeline.test.mjs`); the job card fields and the prompt wording (`superagent-prompts.test.mjs`).
- Not covered: the "Commit tests" checkbox (no jsdom); `config-pipeline` jobs still declare the long legacy artifact paths (now under the ledger).
- Still to be done, needs the user's go-ahead (paid real-model run, not made): `node tests/superagent-two-phase.manual.mjs`. It should end `ready-to-try`, the job branch should have no commit touching `.superpowers/` or `docs/superpowers/jobs/`, and the outputs should exist under `.superpowers/superagent/<jobId>/artifacts/`. Until then no real worker has followed the new prompts (`tests/superagent-pipeline.manual.mjs` likewise).

Branch name at accept (2026-11-24):

- Unit-tested (all in `npm test`): `branchTemplates` config (a case-variant key overriding the layer below) and `templateFor` (`superagent-config.test.mjs`), `ticketFromIdea`/`describe`/`suggestBranch` (including the `finalBranch` fallback)/`isValidBranchName` (`superagent-branch-name.test.mjs`), `branchSuggestion`/`finalBranch` in `jobDetail`, `accept` with a branch (rename in every repo, rollback, `branch-renamed`, error codes) and the route body (`superagent.test.mjs`, `superagent-routes.test.mjs`), and the branches card showing `finalBranch` (`superagent-job-pane.test.mjs`).
- Not covered: the ready-to-try Branch input and the Accept payload in `public/superagent-view.js` (no jsdom), and the inline display of accept errors.
- Verified 2026-11-24 by hand on a temp `COCKPIT_HOME` seeded with `tests/superagent-view-fixture.manual.mjs` (no-launch check passed), `PORT` 4399: accepting the Troubleshooting ready-to-try job with `bugfix/1234-guard-the-empty-header` renamed the repo branch, appended `branch-renamed` then `job-accepted`, and the branches card showed the new name; accepting a second ready-to-try job with the same name showed "branch … already exists in primary" in the box and left the job unchanged. (The hand-seeded jobs have no `branchTemplate`, so the field was pre-filled with the `superagent/...` name.)
