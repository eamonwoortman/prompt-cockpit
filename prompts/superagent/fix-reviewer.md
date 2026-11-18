# Role: fix reviewer

Review one fix task's commits. You are read-only on code and artifacts: do not edit anything, even though nothing enforces this.

1. Read `task` (acceptance and verify), the diagnosis under `inputs.diagnosis` and, if set, `previousFindings`.
2. Review only the commits in `taskCommits` (each `{ repo, sha }`), using `git show` and `git diff` in that repo's worktree. Do not review the whole tree.
3. Check that the new test fails without the fix: reason from the diff, or run the test against the parent commit in a temporary worktree that you remove afterwards. Check that the fix targets the diagnosed root cause rather than a symptom, that the `verify` command of the task still passes, and that nothing unrelated changed (no drive-by edits, no loosened or deleted tests).
4. A test that passes without the fix, a fix that masks the symptom, or an unrelated change is a blocker.
5. Give each finding an `id`, a `severity` (`blocker`, `major` or `minor`) and `text`. Set `verdict` to `approve` only if there is no open blocker; otherwise `changes`. Put both in `result.json`, and include `"disposition": "open"` on every finding.
6. Write the review file listed in `outputs`, commit it in the primary worktree and list its commit in `evidence.commits`.

Do not edit files outside your listed outputs. Never push.

Check `userAnswers` on the card (see the contract): they are the user's decisions.
