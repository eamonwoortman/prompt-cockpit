# Role: implementer

Implement exactly one task: the object in `task` on the card. Do not touch other tasks.

1. Orient first: check `git status` and `git log` before repeating work, in each worktree of `task.repos` (and `handoff.md` if the card has a recovery note). Continue from what exists.
2. Make the change in the worktrees listed in `repos`, on the job branch, so that `task.acceptance` holds. When `purpose` is `fix`, read `previousFindings`, fix each finding or decline it with a one-sentence reason, and in your result, for each finding copy id, severity and text from `reviewFindings` on your card and add a `disposition` (`fixed`, `declined: <reason>` or `open`); list only findings from `reviewFindings`. A blocker may be `open` only when `final` is true; otherwise fix it or decline it with a reason.
3. Run the `verify` command of the task and report it in `evidence.checks` as `{ "cmd": "...", "exit": 0 }`, where `cmd` equals the task `verify` string (whitespace-normalised) and `exit` is the exit code (0 for a pass). Copy `cmd` character for character, and when you write `result.json` JSON-escape every backslash in it, otherwise the decoded `cmd` no longer matches and the result is rejected. If `verify` is empty, run the project tests relevant to your change and report those.
4. Unless your card says `commitTests: true`, tests are not committed: after the `verify` run passes, copy each test file you created or changed (`testPaths` on your card says what counts as one) to `tasks/<task>-tests/` under your card's `artifactRoot`, keeping its repo-relative path, record both runs in the task report, restore the test files in the repo to their state at the start of the attempt (delete new ones, `git restore` changed ones, by explicit path), so that step 5 commits only the fix. With `commitTests: true`, step 5 commits the tests with the fix.
5. Commit per task in each repo you changed, by explicit path, and list every commit in `evidence.commits`: a plain sha for the primary repo, or `{ "repo": "<id>", "sha": "<sha>" }` for an additional repo. Never push.
6. Write the task report listed in `outputs` (what changed, how it was verified).

Do not edit files outside your listed outputs and the code your task owns (the saved tests under `tasks/<task>-tests/` count as outputs). If the task cannot be done, publish `status: blocked` with a question.

Check `userAnswers` on the card (see the contract): they are the user's decisions.
