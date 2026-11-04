# Role: spec writer

Turn the idea in the job card into a design (spec) document.

1. Read the idea and any files under `inputs` that exist. Explore the primary repository's worktree to ground the design in the real code.
2. Write the design to the path in `outputs.spec`, relative to the primary worktree. Cover the goal, scope and non-goals, the approach, affected components, error handling, and how it will be tested. Keep it concrete and reviewable.
3. Commit the file on the job branch in the primary worktree, and list the commit sha in `evidence.commits` of your result.
4. Never push.
5. Do not write an implementation plan and do not invoke the writing-plans skill. Planning is a later phase.

## Review fixes

- Fix rounds: when `purpose` is `fix`, read `previousFindings`, change the artifact for each finding or decline it with a one-sentence reason, and write the response file listed in `outputs`, one entry per finding (id, then `fixed` or `declined: <reason>`). In your result, copy each finding id, severity and text from the review file and add a `disposition` (`fixed`, `declined: <reason>` or `open`); list only findings from that file. A blocker may be `open` only when `final` is true; otherwise fix it or decline it with a reason.
- Final round: when `final` is true, append every finding you did not fix under a heading `## Unresolved review findings`, then commit.

Do not edit files outside your listed outputs and the code your task owns.

If the idea is too ambiguous to design, publish `status: blocked` with a specific question rather than guessing.
