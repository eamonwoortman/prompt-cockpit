# Superagent Plan 5 — automatic brainstorm and the answer path

_2026-11-06 · branch `feature/superagent` @ `178bd2a` · builds on [the superagent design, rev 3](2026-11-03-superagent-design.md)_

Labels: **[Decided]** = decided by the user in the 2026-11-06 brainstorm. **[Author's call]** = chosen by the design author; the user may override. Unlabelled = consequence of the two, or already in the rev 3 spec. Where this document and rev 3 disagree, this document wins for Plan 5.

## Intent

The user wants to hand the superagent an idea and have it fill in missing context before any spec is written, without sitting through questions the idea or the repo already answer. They want to be pulled in only when the idea leaves a real gap. When they are pulled in, their answer must let the job carry on. Today every `needs-you` question is a dead end (`sequencer.js:284`, `sequencer.js:330`), so the answer path is part of this plan, not a later one. **[Decided]**

Of the two ways the stand-in can fail, pulling the user in too often or quietly assuming something wrong that costs a whole pipeline run, the second is worse. But the stand-in still needs autonomy: it should resolve gaps itself on a first try. If it turns out to fail regularly because the initial context is thin, the user and the author will tune it by hand from real runs. It does not learn or self-correct at runtime. **[Decided]**

## Goals

1. **Automatic-mode brainstorm** as the first phase of a job (rev 3 "Automatic-mode brainstorm"): a brainstormer asks questions and writes `brief.md`, and a read-only stand-in answers as the user would. One session runs at a time. **[Decided]**
2. **Stand-in escalation:** a question that changes what gets built, where nothing in the idea or the project hints at an answer, becomes a `needs-you` question, and the brainstorm waits on that one answer. **[Decided]**
3. **Answer path for every `needs-you` question**, whichever worker raised it: the stand-in in a brainstorm, an author worker that published `status: blocked` with a question, or a review loop's verifier-confirmed blocker. The answer goes to the worker scope that asked and the job resumes in the phase where it stopped. **[Decided]**
4. **Inspectable stand-in behaviour**, so it can be tuned from real runs: every exchange is kept with its tag and a one-line reason. **[Decided]**

## Non-goals (for Plan 5)

- Manual-mode brainstorm (the user chatting with the brainstormer, **Hand over**). The user does not want to work that way first. It stays in rev 3 for a later plan. **[Decided]**
- Any UI, server routes or notifications. Those are Plan 6: the Superagent tab's Needs-you pane with an answer box, the badge, bell entries and browser notifications (rev 3 "The Superagent view", "Notifications"). Plan 5 exposes a library function that Plan 6 will call. **[Decided]**
- Runtime learning: the job does not go back and re-ask about an assumption when later phases fail. **[Decided]**
- Resuming `stuck`, `budget` or `tasks-invalid`. These stay terminal until the feedback/resume plan.
- Context-drift rotation of brainstorm sessions (rev 3 "Bounded", second sentence). The exchange cap keeps brainstorms short. **[Author's call]**
- Real-model probe runs. The user punted all probing until every plan is done. Plan 5 is verified with scripted workers, as in Plans 3 and 4. **[Decided]**
- One answer closing several open questions at once. One answer closes one question. **[Decided]**

## Anti-goals

Rev 3's three still apply: burning tokens, context drift, too much user attention. For this plan specifically:

- A brainstorm that asks the user something the idea or the repo already answers is a failure, even if the brief comes out fine.
- A stand-in that assumes something with big impact on what gets built, when the evidence is thin, instead of asking, is a worse failure.
- Keeping a model session open while a job waits for the user (slot held, context lost on restart anyway) is a failure. **[Decided]**

## The brainstorm phase

**Where it sits.** The default config already declares it (`config.js:53`): `{ phase: 'brainstorm', kind: 'author', role: 'brainstormer', inputs: ['idea'], outputs: ['brief'] }`, with spec taking `['brief']`, and `models['stand-in']` / `models.brainstormer` on `claude-opus-5-5` (8 and 60 turns), plus `limits.brainstormExchanges: 20` and `limits.brainstormTokens: null`. Plan 5 makes that pipeline runnable. The `milestone-1` / `milestone-2` fixtures start at spec with `idea` in and must keep working unchanged.

**Roles and templates.** Two new templates: `prompts/superagent/brainstormer.md` and `prompts/superagent/standin.md`, self-contained like the others (rev 3 "Workers": a template may lean on a superpowers skill but must override anything that crosses the phase boundary; the brainstorm stops at `brief.md`, never writes a design doc, never invokes writing-plans; no visual companion).

**Exchanges.** The brainstormer asks; the stand-in answers; repeat. Only one of the two sessions runs at a time. The stand-in's tool set is read-only: Read, Grep, Glob over the job's worktrees, with no Write, Edit or Bash. The runner does not support restricting tools today (`runner.js:391-405`), so it gains that option. **[Decided: read-only, serialised; rev 3]**

**The stand-in's rules.** **[Decided]**
- Answer from the idea first, the project second, and only then assume.
- Tag every answer `from-idea`, `from-project` or `assumed`, with a one-line reason (what in the idea or which file it relied on, or why the assumption is safe).
- Default to autonomy. Assume and tag small calls that the spec phase could settle anyway, like naming or minor detail.
- Escalate when a question would change what gets built and nothing in the idea or project points to an answer. When unsure whether something has that kind of impact, lean towards asking.

**Escalation.** The stand-in escalates with a question for the user. The job goes to `needs-you` / `question` with the question, the brainstormer's original question and the stand-in's reason in the detail, so Plan 6 can show all three. No brainstorm session stays open while the job waits. **[Decided]**

**After the user answers.** The answer is recorded as an exchange tagged `from-you`. The brainstorm resumes from the durable record (idea, every exchange so far, the answer) in fresh sessions, not from a parked one. **[Decided: nothing stays running; Author's call: `from-you` tag]**

**Ending.** The brainstorm ends when the brainstormer publishes a valid result with `brief.md` ("no questions left"). If the exchange cap or the token cap (`brainstormTokens`, null = none) is reached, the brainstormer is told to write the brief now, with remaining unknowns as assumptions. Exchanges answered `from-you` do not count towards the exchange cap. **[Author's call]**

**The brief.** `brief.md` (path from `artifactPaths(job).brief`) contains what is being built and why, plus two required sections: **"Assumptions made for you"** (every `assumed` answer, with its reason) and **"Your answers"** (every `from-you` exchange). The spec-writer must carry both sections forward into the spec unchanged in meaning, because later phases only see the spec (v1 composition fixes their inputs, `config.js:116-124`, and Plan 5 does not change that rule or the default pipeline). The spec-writer template says so, and spec validation checks that both headings exist in the spec when the job has a brainstorm phase. Later workers treat "Your answers" as the user's decisions and "Assumptions made for you" as reviewable defaults. Rev 3 already surfaces the assumptions at acceptance. **[Decided: assumptions listed; Author's call: section names, "Your answers", and carrying forward through the spec]**

## The answer path

**The entry point.** A library function on the supervisor, `answerQuestion(jobId, text)` (exact name and signature are the builder's). It accepts an answer only when the job is in `needs-you` / `question`. It rejects any other state, an empty answer, and a second answer to a question that's already answered. It records the answer as an event and hands the job back to the supervisor's heartbeat. Plan 6's answer box calls it. **[Decided: answer resumes the job; Author's call: shape]**

**Durability.** The answer lives in `events.jsonl` like every other state change, so it survives a cockpit restart, and `deriveJob` returns the job to `running` in the same phase.

**Who gets the answer.** The worker scope that asked: **[Decided]**
- **Brainstorm (stand-in escalation):** the next exchange carries the answer as `from-you` (above).
- **Author phase (a worker published `status: blocked` with a question):** a fresh attempt for the same role and phase. Its prompt carries the original question and the user's answer as well as the normal context. Like every author retry, it gets the rev 3 recovery note, so it checks worktrees before redoing work.
- **Review loop (verifier-confirmed blocker after the round cap, `sequencer.js:68-90`):** **[Author's call, all of this bullet]**
  - The answer is the user's decision on that blocker. The author, the reviewer and the verifier of the extra round all get it as authoritative. If the answer dismisses the blocker ("that's fine, leave it"), the blocker is closed: the author declines it citing the answer, and the reviewer and verifier must not raise or confirm it again.
  - The loop gets one extra fix + review round with its own round number, after the existing final round (for example `r<maxRounds+1>`, so its review and response paths don't collide with `results.js:65-66`). The extra fix is `final`, so blockers the answer doesn't cover may stay `open`.
  - After the extra review, any blocker still open, whether the answered id or a new one, goes through the normal cap path: the verifier, then confirmed blockers become a new `needs-you` question. That question is subject to the round-trip bound below. Minor findings carry on as "Unresolved", as today.
- **Per-task scope (implementer or task-review question):** as above, scoped to that task.

**Caps.** An answered question does not count against the scope's attempt cap. A question the user answered is not a failed attempt. **[Author's call]**

**Round-trip bound.** Each scope (a phase, or one task in the per-task phase) may bring at most 3 questions to the user. When a worker in that scope would raise a 4th, the job goes to `needs-you` / `stuck` with a new reason (for example `question-cap`) instead of asking again. A worker needing that much help points to a thin idea or brief, not a lack of answers. The brainstorm scope counts stand-in escalations the same way. The limit is a new `limits` key with default 3, validated like the other limits. **[Decided: 3 per scope, then stuck; Author's call: key name and reason name]**

## Inspectability

**[Decided]** Every exchange is durable and inspectable without opening session transcripts: the brainstormer's question, the answer, its tag, the stand-in's reason, the time, and which attempts and sessions produced them. The builder chooses the format: events, or a file in the attempt or job folder. Whatever is chosen, "list every `assumed` answer for job X with its reason" must be a straightforward read, because that is how the user and the author will tune `standin.md` after real runs. The `needs-you` detail and the brief point back to these records.

## Constraints

- Everything in rev 3 that Plans 1-4 rely on still holds. That includes the result contract, atomic publish, the phase-boundary stop, `UNATTENDED_DENY_MESSAGE` for every other worker, the per-job chain, and the router only routing (it never answers a question).
- `maxConcurrentSessions` counts live sessions. A brainstorm counts as one because its two sessions never run at the same time (rev 3 "Jobs and the pipeline").
- Brainstormer and stand-in sessions are superagent-owned rows. Their asks must not reach the normal approval path or the bell. The brainstormer's `AskUserQuestion` currently falls through to the human (`runner.js:467`). In automatic mode it must be answered by the stand-in instead, or the brainstormer must ask in text. The builder chooses. Either way, no question from a superagent session reaches the user except through `needs-you`.
- No new dependencies. No changes to `package.json`.
- Scripted-worker tests in the style of `tests/superagent-pipeline.test.mjs`. `npm test` stays fast and makes no network calls. `tests/README.md` and `CLAUDE.md`'s Superagent paragraph are updated in the same plan.
- Commits carry no Co-Authored-By trailer, `package-lock.json` is not committed, and nothing is pushed.

## Left to the builder

- The relay mechanism: one long-lived session per side, parked between turns, or a fresh attempt per exchange fed from the record. `AskUserQuestion` interception versus text questions. How the token cap is measured.
- Event names and shapes (for example `brainstorm-exchange`, `question-answered`) and how `deriveJob` folds them.
- How the stand-in signals escalation versus an answer in its output.
- Whether a `milestone-3` fixture (brainstorm in front of `milestone-2`) is added for tests, or tests run the default config's pipeline.
- Template wording, within the rules above.
- Validation of `brief.md`'s required sections (headings present) and how strict it is.
