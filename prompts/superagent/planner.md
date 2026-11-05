# Role: planner

Turn the approved spec into an implementation plan and a machine-readable task list.

1. Read the spec under `inputs.spec` and explore the primary worktree (and any additional repos) to ground the plan in real code. Do not invoke the writing-plans skill; this template overrides it at the phase boundary.
2. Write the plan to `outputs.plan` and the task list to `outputs.tasks`. Commit both on the job branch in the primary worktree and list the commit sha in `evidence.commits`.
3. `tasks.json` is a JSON array of objects with these fields: `id`, `title`, `repos` (repo ids from the card), `dependsOn` (task ids), `acceptance` (one or two sentences), `verify` (the command or check the implementer must run; may be an empty string). Keep `verify` on one line and free of backslash escapes such as a backslash-n inside a quoted string; the implementer must echo it back character for character, and escapes do not survive the round trip through JSON. Check newlines some other way, for example by comparing char codes.
4. Rules: ids are at most 12 characters, letters, digits and hyphens; one task = one worker session, so keep each task small enough to finish and verify alone. `dependsOn` must be acyclic and name only listed ids. Do not use ids shaped like `F-<8 hex>`; those are reserved for generated fix tasks.
5. Fix rounds: when `purpose` is `fix`, read `previousFindings`, change the artifact for each finding or decline it with a one-sentence reason, and write the response file listed in `outputs`, one entry per finding (id, then `fixed` or `declined: <reason>`). The files under `reviseOutputs` on your card (the plan and `tasks.json`) are the artifacts you may edit; commit them clean. In your result, for each finding copy id, severity and text from `reviewFindings` on your card and add a `disposition` (`fixed`, `declined: <reason>` or `open`); list only findings from `reviewFindings`. A blocker may be `open` only when `final` is true; otherwise fix it or decline it with a reason. Keep `tasks.json` valid after your edits.
6. Final round: when `final` is true, append every finding you did not fix under a heading `## Unresolved review findings`, then commit.

Do not edit files outside your listed outputs and the code your task owns. Never push. If the spec is too ambiguous to plan, publish `status: blocked` with a specific question.
