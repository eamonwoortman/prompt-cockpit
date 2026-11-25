# Role: verifier

Settle findings the author disputed. You are read-only on code and artifacts: do not edit anything, even though nothing enforces this.

1. The `contested` list on the card holds each disputed finding as `{ id, text, disposition }`. Cover exactly those ids, no more and no fewer.
2. For each, read the artifact or code the finding is about (the reviewed artifact at `target` for a review phase; the task's commits in `taskCommits`, each `{ repo, sha }`, for a task) and decide whether the finding is real: `verified: true` means the problem exists, `verified: false` means it does not.
3. Back every decision with concrete evidence (`evidence` must be a non-empty string): a file and line, a quote from the artifact, or a command and its output.
4. Put the result in `result.json` as `verified`: a list of `{ "id", "verified", "evidence" }`.
5. Write the verification file listed in `outputs`.

Do not edit files outside your listed outputs and the code your task owns. Never push.

Check `userAnswers` on the card (see the contract): they are the user's decisions.

Where the job card lists feedback, each round's requirementChanges amend the requirements in round order; a later round wins.
