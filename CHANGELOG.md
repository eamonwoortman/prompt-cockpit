# Changelog

All notable changes to this project are documented here.

## [0.3.1]
- Chain: the full transcript goes to the new session as a private temp file
  (tool results capped); the first message is a pointer plus the last
  exchange. Falls back to the inline recap if the file cannot be written
- Chained sessions open in a new browser tab; the source tab stays put
- Chain: the auto permission mode carries over reliably, applied after the
  provider reports its own init
- Chain: "I'm away now" checkbox in Settings > Project replaces the Away
  button in the activity bar; Report state moves to a Diagnostics row
- Codex: rate-limit reset time shown when a 5h or 7d window is exhausted;
  auto-continue enabled
- Codex: MCP tool-call approvals show Allow and Deny instead of being declined
- Sessions can ask each other with the ask_session and list_sessions MCP tools
- Settings: checkbox to hide the built-in ListAgents and SendMessage tools
  (new Claude sessions)
- Launcher: one provider:account dropdown replaces the separate provider and
  subscription selects; the last pick is remembered
- /ask: backspacing the command keeps the picker open; Tab brings the name back
- Tab title: the state emoji is the favicon and the title stays clean
- Stats panel: session cost rounds up to the next cent
- Git guard: titles accept comma-separated scopes; blank lines between bullets
  are rejected with the fix explained
- Pricing: gpt-6.1-terra added to the Codex table
- Dependencies: zod declared as a direct dependency; lockfile refreshed for
  hono and @hono/node-server

## [0.3.0]
- Chain: continue a session in a new session on another provider or Claude
  login folder, from "Chain to..." or automatically on a rate limit
  (Settings > Project; per folder). A text summary of the conversation is sent
  as the first message; the original session stays open
- Drop and paste files or screenshots into the compose box; files outside the
  project are saved under .claude/cockpit-uploads/ and referenced with @path
- Tab title shows a state emoji (approval waiting, finished, running, error)
- Tool-call visibility setting: show all, hide successful, or hide all, with a
  button to reveal hidden calls for the detail pane
- Detail pane: Changes tab gains git sources (unstaged, staged, HEAD) and net
  +/- counts
- Claude effort is shown as "default" when unset instead of assuming High
- Pricing: long-context tiers, Haiku 5.5, Fable 5.2, Mythos 5.2, more Grok and
  Codex models, Sonnet 5.5 cache-read fix
- Installs skip dependency scripts (.npmrc); Claude Agent SDK 0.3.300

## [0.2.2]
- Detail pane: new Changes tab with a per-file table of edits (+/- lines,
  totals); click a row to open that file's last edit
- Fixed a server crash on startup when the Claude quota lookup closed its
  query mid-request (unhandled "Query closed before response received")
- Claude Agent SDK 0.3.289

## [0.2.1]
- Multiple Claude accounts: pick a subscription in the launcher (extra
  accounts via `claudeSubscriptions`); sessions keep it through resume,
  history, reset, and rewind
- Claude and Codex 5h/7d quota in the launcher and live sessions
- Thinking Off and token budgets gated by model
- Reset keeps model, effort, and thinking settings
- Folded tool groups summarize each call; settings modal is resizable
- Optional git guard for scoped commit messages and push confirmation
- Fixed `[]` in non-Grok model names and a storage worker exit race
- Pricing: claude-sonnet-5-5, gpt-6.1-sol
- Claude Agent SDK 0.3.288, ws 8.22.0

## [0.2.0]
- Global Stats heatmap now colors cells by provider (Claude/Grok/Codex) and
  adds an on-demand last-7-day cost split by provider
- Usage-stats scanning cached and bounded: mtime-keyed memoization across
  Claude, Grok, and Codex transcripts, stale-while-revalidate, no more
  blocking rescans
- Streaming render performance: markdown re-renders coalesced to one rAF
  per block, `cockpit:usage` broadcasts throttled, history prepends chunked
  across animation frames to stop full-tab freezes on large sessions
- Tool result syntax highlighting improved, including PowerShell and batch
  detection
- Turn-chart axis and cost labels switched to a nice-scale, 4-decimal
  format for Grok-scale (sub-dollar) bars
- New offline `codex_usage.py`: reads Codex rollout JSONL directly for a
  cost/token report with no server or network involved
- Pricing kept current: GPT-6 Astra/Sol/Luna, GPT-6.1 Sol, Claude Opus 5.5,
  Fable 5.1, Mythos 5/5.1, and Grok 4.7 all added as each became available

## [0.1.7]
- Codex reaches feature parity with Claude and Grok: rewind (forks through
  the selected completed turn, including its response), native MCP and
  plugin controls, MCP OAuth login, and slash commands from `skills/list`
- Codex models discovered live from `model/list` instead of a static
  catalog; the effort picker narrows to what the selected model supports
- Codex token usage normalized into the shared cost accounting, with
  cumulative thread totals converted to per-turn deltas and a resume
  baseline so a resumed thread is not charged twice
- Codex plan quota shown in the cost strip, alongside a new 7-day window
  chip for every provider
- Approvals: `requestUserInput` questions, legacy exec/patch approval
  shapes, and cross-tab resolution so a decision in one tab clears the
  banner in the others
- Tool rows stream live on `item/started` and close on `item/completed`
  instead of appearing only once finished
- Windows tool rows show the real command and basename instead of an
  escaped path or a `powershell.exe -Command` prefix
- Turn ownership hardened for multiple sessions sharing one Codex thread:
  no dropped events during the `turn/start` race, no cross-session
  interrupts, and bounded retention of turn/item ids
- `pricing_codex.json` gained gpt-5.5 and gpt-5.6 rates
- Renamed from `claude-prompt-cockpit` to `prompt-cockpit`: the npm package
  name and Grok's ACP handshake both dropped the `claude-` prefix left over
  from before Grok and Codex existed. Both Grok and Codex now read their
  reported version from `package.json` instead of a hardcoded copy

## [0.1.6]
- Security: CSP/X-Frame-Options/nosniff headers, 1MB request/WS payload
  caps, timing-safe token comparisons
- `pricing_codex.json` added: Codex cost/tokens now show instead of
  dropping silently for unpriced models; Global Stats tab labeled
  Claude-only
- Grok Stop button now drains queued prompts, not just the in-flight turn
- Task/Agent panes folded into the docked detail pane, replacing the old
  `agent-view.html` pop-out tab
- Edit/Write/Bash tool payloads syntax-highlighted (Prism.js); Edit/MultiEdit
  diffs rendered CLI-style with a gutter and block tint
- Subagent-aware spinner and highlighting; turn-chart keeps a
  chart-selected tool group open
- `/healthz` liveness check and `/api/system/memory` introspection added
- `session-registry.js`/`app.js` split into focused modules
  (`delegation.js`, `approval-panel.js`, per-concern CSS files, etc.)
- `result-epoch.js` unifies turn-tracking, replacing duplicated FIFO logic
  between `session-registry.js` and each provider's handle
- `session-actions.js` refactored from a 520-line if-chain to a
  lookup-table dispatcher; dead code and duplicate `escapeHtml` removed

## [0.1.5]
- Widened slash-command dropdown; sorted alphabetically, substring match
- Fixed account-limits tests hanging on Windows (injectable execFile)
- Gate every `/api` and `ws` route behind a process operator token
- `/ask` delegation trust anchor and picker; settings modal split into tabs

**Note:** commit history on `main` was rewritten (all commit messages
reformatted to scoped-commit style) for this release. If you already have
a clone, sync it with:
```
git fetch origin
git checkout main
git reset --hard origin/main
```
Any local branches based on the old commits will need rebasing onto the
new history, or just re-cloning.

## [0.1.4]
- Codex added as a third session provider, alongside Claude and Grok
- Provider architecture refactored; Codex wired into launcher and UI
- Codex session lifecycle, rewind, and effort-validation fixes
- Security review fixes: ReDoS, delegation FIFO desync, route hammering

## [0.1.3]
- Cross-session delegation: relay, message rendering, handshake secret
- Per-tool cost breakdown, session-count fixes, tooltips
- Split server routing; stuck-session recovery and debug tooling

## [0.1.2]
- Grok fork/effort support, MVP5 `/ask` delegation, Grok stream fixes
- Live Grok turn cost forwarded via `session_notification`
- Markdown renderer extensions; MCP "needs auth" Authenticate link
- General quality-of-life improvements

## [0.1.1]
- Grok-CLI-parity session controls: cancel turn, `/compact`, visible input
  queue, permission always-allow, plan review, persisted prompt history
- Claude replies rendered as Markdown
- Redesigned tool-call rendering with a docked detail pane
- Fixed `@` file picker gap and cost-graph slider; closed test gaps
- README cleanup (screenshot added, Plan section removed)

## [0.1.0] - Initial release
- Local browser UI for driving a Claude Code session against a project folder
- Initial README with Run instructions
