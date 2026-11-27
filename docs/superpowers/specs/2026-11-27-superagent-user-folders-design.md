# Superagent: several user folders for workflows and prompts

## Intent

The Settings dialog (`#superagentSettingsModal`) shows one user folder, and it misleads: it says "Workflows found / None found." while the New-job picker lists `fg-level`, because `settings()` (`src/superagent/index.js`) keeps only `source === 'user'` workflows and `fg-level.json` lives in the `global` folder (`<superagent root>/workflows`). The user wants to see every folder that feeds workflows and prompts, to source them from more than one place, and to control which one wins.

## Goals

- `config.json` holds an ordered list of user folders. The UI shows it as a list where the user can add, remove, reorder (move up/down) and view (expand) each folder.
- Each folder row expands to two collapsible lists, Workflows (n) and Prompts (n), with every item marked used, shadowed (naming the folder that wins) or invalid (with the reason).
- The `global` folder appears as a fixed entry: viewable, not removable, not movable.
- The modal body scrolls when the content is taller than the modal.
- A higher folder in the list wins over a lower one, for workflows (by id, case-insensitive) and for role prompts (by file name).

## Non-goals

- Built-in workflows and project overrides are not listed as rows (a note mentions project overrides).
- Opening a folder in the OS file manager.
- Treating a junction or symlink alias as the same folder as its target (paths are compared as resolved text, case-folded on Windows).
- Changing how running or existing jobs resolve prompts beyond reading their recorded list.

## Anti-goals

- An existing job changing the prompts it uses because the setting changed.
- A missing folder or an invalid folder setting hiding the other folders' workflows. (A broken *file* does shadow lower copies of its id, by design; see Decided.)
- Two sources of truth in `config.json` (both `userFolder` and `userFolders` written).

## Approaches

1. **New `userFolders` list (picked).** `config.json` gets `userFolders: string[]`, the old `userFolder` is read as a one-item list and removed on the next save. One shape everywhere.
2. Keep the `userFolder` key, accepting a string or an array. Less churn in `config.js`, but every reader handles both forms forever and the name is wrong.

The user picked 1.

## Decided

- **Precedence:** project > user folders in list order (first wins) > global > built-in. Same-id workflows across two user folders: the higher folder wins, the lower entry is shown shadowed in the dialog and is not in the picker. Same-id workflows inside one folder stay invalid, as today (`duplicate id ... in the user workflows`, now naming the folder). An invalid or duplicated file in a higher folder still wins, as overrides do today: the picker lists it as invalid and the lower folder's copy is shown shadowed by it, never silently used instead.
- **Prompts:** role prompt lookup is project override > the workflow's own `prompt` > the first user folder (in order) with `prompts/<role>.md` > built-in. The global folder still supplies no prompts. `contract` is still always built-in, and a declared workflow prompt that is missing still does not fall through.
- **Global folder:** a fixed entry listed below the user folders, labelled "workflows only".
- **Storage:** `config.json` `userFolders: string[]`. Each entry follows today's `resolveUserFolder` rules (absolute or `~`-prefixed, at most 1000 characters). New jobs record the resolved list, in order, as `job-created.userFolders`.

## Builder's calls (proposed in conversation, not objected to)

- **Default:** unset `userFolders` and unset `userFolder` means `[~/.prompt-cockpit]` (today's default, `<COCKPIT_HOME or home>/.prompt-cockpit`). An explicit `[]` means no user folders. A legacy `userFolder: null` is treated as unset.
- **Migration:** `userFolder: "X"` with no `userFolders` reads as `["X"]`. Any write of the list writes `userFolders` and deletes `userFolder`. If both keys exist, `userFolders` wins and `userFolder` is ignored (and removed on the next write).
- **Invalid entries:** each entry is validated on its own. An invalid stored entry is listed as an invalid row with its error and contributes nothing; the other folders still work. It is listed as one invalid `user` workflow entry in the picker, as today, so a broken setting is visible. A non-array `userFolders` makes the whole setting invalid (one error row, no user folders).
- **Duplicate folders:** the same resolved path twice is refused when adding (`ERR_INVALID_REQUEST`). Compare case-insensitively on Windows.
- **Apply immediately:** add, remove, up and down each POST the whole new list and re-render from the response. The Save and "Use default" buttons go, and Close stays. The add row is a text field and an Add button.
- **Creating folders:** adding a folder that does not exist creates it with `workflows/` and `prompts/`, as `setUserFolder` does today, before `config.json` is written. If creation fails, return `ERR_INVALID_FOLDER` (400) and leave `config.json` untouched. Remove and reorder do not create or delete anything on disk.
- **POST diffs against the stored list:** an entry whose string equals a stored entry's string is kept as-is: no validation, no creation, no duplicate check. So a stored folder that is missing, invalid or duplicated never blocks a reorder or an unrelated add, and it keeps showing its error row. Only entries not in the stored list are validated, refused as duplicates of any other entry in the new list (resolved path, case-insensitive on Windows), and created. A stored non-string entry cannot be sent back, so it is shown as an invalid row and is dropped by the next change made from the dialog. A stored duplicate is listed as invalid ("same folder as #N") and contributes nothing.
- **Old jobs:** `deriveJob` exposes `job.userFolders`. It is `job-created.userFolders` when present, else `[userFolder]` when the old field is a string, else `[]` (a job without either never reads the default folder, as today). A recorded `null` entry (an invalid folder at create time) is dropped. `buildWorkerPrompt` and `hasTemplate` take the list.

## API

- `GET /api/superagent/settings` returns:
  - `folders: [{ configured, resolved, error, exists, fixed: false, workflows: [...], prompts: [...], note }]` in list order, then the fixed global entry `{ resolved, exists, fixed: true, workflows, prompts: [], note }`.
  - Each workflow item is `{ id, name, file, valid, errors, description, status: 'used' | 'shadowed' | 'invalid', shadowedBy }`. `shadowedBy` is the winning folder's resolved path. The GET takes no project, so project overrides are not computed: they are only mentioned in the note, and `shadowedBy` is never `'project'`. A global workflow can be shadowed by a user folder, never the other way round.
  - Each prompt item is `{ file, role, status: 'used' | 'shadowed' | 'ignored', shadowedBy, reason }`. `ignored` covers `contract.md` and non-role names, as today.
  - `default` (the default folder path) and `isDefault` (true when nothing is stored).
- `POST /api/superagent/settings` takes exactly `{ userFolders: string[] | null }` (`null` resets to the default). Anything else is 400 `ERR_INVALID_REQUEST` `userFolders must be a list of paths or null`. It validates every entry, refuses duplicates, creates missing folders, writes `config.json` and returns the new `settings()`.

## Touch points

- `src/superagent/config.js`: `resolveUserFolders`, `userFolders()`, `checkUserFolders()`, `setUserFolders()`, `save()` validation, and the migration rule. Keep `resolveUserFolder` for per-entry checks.
- `src/superagent/workflows.js`: `loadWorkflows` takes `userDirs` (ordered) plus per-entry errors, with one `user` layer per folder. Winner and duplicate logic distinguishes folders. A shadow-aware listing is exposed for `settings()`. `resolvePromptPath` takes `userPromptsDirs`.
- `src/superagent/prompts.js`, `store.js`, and `index.js` (`createJob`, `settings`, `setUserFolders`, `hasTemplate` checks).
- `src/routes/superagent.js` (POST body).
- `public/superagent-settings.js` (pure summary), `public/superagent-view.js` (dialog), `public/index.html` (modal markup), and `public/style-superagent.css`. Scrolling: the `.modal-box > .modal-body` rule already sets `overflow-y: auto` under an 80vh box; check it holds with the new markup.
- Tests: existing user-folder tests in `tests/superagent*.test.mjs` move to the list form. Add tests for migration, order and shadowing, per-entry invalid, duplicates, old-job fallback, the route body and `settingsSummary`.
- Docs: the **User folder** paragraph in `CLAUDE.md`, and `tests/README.md` (dialog wiring stays hand-verified).

## Left to the builder

- Exact markup and CSS for rows, the `<details>` nesting, and the up/down/remove buttons (match the existing `sa-*` styles).
- Internal function names and how the shadow-aware listing is factored.
