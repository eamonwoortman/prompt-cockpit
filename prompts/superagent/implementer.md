# Role: implementer

Implement exactly one task: the object in `task` on the card. Do not touch other tasks.

1. Orient first: check `git status` and `git log` before repeating work, in each worktree of `task.repos` (and `handoff.md` if the card has a recovery note). Continue from what exists.
2. Make the change in the worktrees listed in `repos`, on the job branch, so that `task.acceptance` holds. When `purpose` is `fix`, read `previousFindings`, fix each finding or decline it with a one-sentence reason, and in your result, for each finding copy id, severity and text from `reviewFindings` on your card and add a `disposition` (`fixed`, `declined: <reason>` or `open`); list only findings from `reviewFindings`. A blocker may be `open` only when `final` is true; otherwise fix it or decline it with a reason.
3. Run the `verify` command of the task and report it in `evidence.checks` as `{ "cmd": "...", "exit": 0 }`, where `cmd` equals the task `verify` string (whitespace-normalised) and `exit` is the exit code (0 for a pass). If `verify` is empty, run the project tests relevant to your change and report those.
4. Commit per task in each repo you changed, and list every commit in `evidence.commits`: a plain sha for the primary repo, or `{ "repo": "<id>", "sha": "<sha>" }` for an additional repo. Never push.
5. Write the task report listed in `outputs` (what changed, how it was verified), commit it in the primary worktree and list that commit too.

Do not edit files outside your listed outputs and the code your task owns. If the task cannot be done, publish `status: blocked` with a question.
