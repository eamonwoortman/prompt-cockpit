# Superagent: several user folders - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `userFolder` setting with an ordered `userFolders` list (first wins), and rebuild the Settings dialog as a folder list you can add to, remove from, reorder and expand. The list includes a fixed `global` entry.

**Architecture:** `config.js` owns the setting: it reads it, migrates the legacy key, validates per entry and writes it. `workflows.js` turns each user folder into its own precedence layer and also reports shadowed entries. `index.js`'s `settings()` builds one row per folder from that. The browser's `superagent-settings.js` stays pure (summary plus list operations), and `superagent-view.js` renders it.

**Tech Stack:** Node.js ESM, `node:test`, vanilla JS frontend, no build step.

**Spec:** `docs/superpowers/specs/2026-11-27-superagent-user-folders-design.md`

## Global Constraints

- Precedence: project > user folders in list order (index 0 wins) > global > built-in, by workflow id (case-insensitive, `sameWorkflowId`). Role prompts: project > workflow `prompt` > first user folder with `prompts/<role>.md` > built-in. Global supplies no prompts. `contract` is always built-in.
- An invalid or duplicated file in a higher layer still wins and shadows lower copies.
- Same-id files inside one folder are all invalid: `duplicate id "<id>" in the user workflows of <resolved folder>` (`global`/`project`/`built-in` keep `duplicate id "<id>" in the <source> workflows`).
- Each entry follows `resolveUserFolder` (absolute or `~`-prefixed, at most `USER_FOLDER_MAX_CHARS` = 1000).
- Unset `userFolders` and unset (or `null`) `userFolder` give `[<home>/.prompt-cockpit]`. `[]` gives no user folders. `userFolders` beats `userFolder`. Every write sets `userFolders` and deletes `userFolder`. A reset (`null`) deletes both.
- POST body: exactly `{ userFolders: string[] | null }`, else 400 `ERR_INVALID_REQUEST` `userFolders must be a list of paths or null`.
- Folder creation failure: 400 `ERR_INVALID_FOLDER`, with `config.json` untouched.
- Job record: `job-created.userFolders` (resolved paths, valid entries only, in order). `deriveJob` gives `job.userFolders`: the recorded array (strings only), else `[userFolder]` for a legacy string, else `[]`.
- Superagent tests never read the real `~/.prompt-cockpit`.

## Review Focus

1. **A stored folder that is missing, invalid, non-string or duplicated must not block reorder, remove or an unrelated add.** POST diffs against the stored list (Task 4 test `setUserFolders keeps stored entries as-is`).
2. **Windows case:** `C:\A` and `c:\a\` are the same folder for duplicate refusal and shadowing (Task 1 test `duplicate detection folds case on win32`).
3. **Old event logs:** a job created with `userFolder: "X"` still reads `X/prompts` after the setting becomes a list (Task 3 test `legacy userFolder becomes a one-item list`).
4. **Supervisor tests reading the real home:** the `superagent.test.mjs` harness builds `createSuperagentConfig({ filePath })` without `home`, so it reads the real `~/.prompt-cockpit/workflows` (**Confirmed** at `tests/superagent.test.mjs:42`; it contradicts CLAUDE.md). Task 4 passes `home: root`.
5. **Two user folders, same prompt file:** the higher one is used at launch, the lower one is shown shadowed (Task 2 `resolvePromptPath` test and Task 4 `settings()` test).

---

### Task 1: `config.js` - read, validate and write `userFolders`

**Files:**
- Modify: `src/superagent/config.js` (`resolveUserFolder` stays; the `userFolder()`/`checkUserFolder()`/`setUserFolder()` methods at ~434-461 are replaced; `save()` validation at ~466)
- Test: `tests/superagent-config.test.mjs`

**Interfaces:**
- Produces:
  - `resolveUserFolders(fileConfig, { home, platform }) -> { isDefault: boolean, default: string, error: string | null, entries: Entry[] }`
    - `Entry = { index: number | null, raw: unknown, configured: unknown, resolved: string | null, error: string | null }`
      - `raw` is the stored value, untouched.
      - `configured` is the trimmed string, as today.
    - `userFolders: null` counts as unset.
    - `error` is the whole-setting error (a non-array `userFolders`). `entries` is then exactly one invalid entry, `{ index: null, raw: value, configured: value, resolved: null, error }`. Task 2 turns it into the invalid `user` entry, so both the picker and the dialog show it.
    - A later entry with the same resolved path as an earlier one gets `resolved: null, error: 'same folder as #<n>'` (1-based).
  - `planUserFolders(next: string[], stored: Entry[], { home, platform }) -> { error: string } | { entries: { configured: string, resolved: string | null, isNew: boolean }[] }`
    - Posted items are matched against the stored entries' `raw` strings as a multiset. Each stored string can be claimed by one posted item only, by exact string equality with no trimming. A claimed item is kept as-is (`isNew: false`, the stored `resolved`).
    - Every unclaimed item is validated with `resolveUserFolder`. It is refused if its resolved path equals the resolved path of any other posted item, kept or new.
    - The error text is `${JSON.stringify(item)}: <message>`. For a duplicate the message is `same folder as #<n>`, where n is the 1-based position in the posted list.
    - Two paths are the same folder when their resolved text matches: case-folded on win32, trailing separator stripped. Junctions and symlinks are not resolved.
  - Config methods: `userFolders() -> resolveUserFolders(...)` result, `planUserFolders(next)` (bound to the stored entries), `async setUserFolders(list: string[] | null)` (the `updateJson` write; `ERR_CONFIG_CORRUPT` on a non-object; fs errors rethrown).

- [ ] **Step 1: Write the failing tests** in `tests/superagent-config.test.mjs` (with `home = path.join(path.sep, 'home', 'x')`):
  - `userFolders: unset gives the default, [] gives none`: `resolveUserFolders({}, { home })` gives `isDefault: true` and `entries.map(e => e.resolved)` equal to `[path.join(home, '.prompt-cockpit')]`. `{ userFolders: [] }` gives `isDefault: false, entries: []`. `{ userFolder: null }` gives the default.
  - `legacy userFolder reads as a one-item list, userFolders wins over it`: `{ userFolder: '~/a' }` gives one entry with resolved `path.join(home, 'a')`. `{ userFolder: '~/a', userFolders: ['~/b'] }` gives only `~/b`.
  - `entries are validated one by one`: `{ userFolders: ['~/a', 'relative', 7] }` gives entries 1 and 2 with errors and entry 0 resolved. `{ userFolders: 'x' }` gives `error` matching `/userFolders must be a list/` and `entries: []`.
  - `duplicate detection folds case on win32`: with `platform: 'win32', home: 'C:\\Users\\x'`, `['C:\\A', 'c:\\a\\']` makes entry 1 error `same folder as #1`. On linux, `['/a', '/A']` are both valid.
  - `planUserFolders keeps stored items and checks new ones`: stored `['/ok', 'relative']` (entry 1 invalid). `planUserFolders(['relative', '/ok', '/new'])` gives `isNew` `[false, false, true]`. `planUserFolders(['/ok', '/ok/'])` gives an error matching `/"\/ok\/": same folder as #1/`.
  - `a stored string is claimed once`: with stored `['/a']`, `planUserFolders(['/a', '/a'])` is refused with `same folder as #1`. With stored `[' /a ']`, `planUserFolders([' /a '])` keeps it (`isNew: false`).
  - `a non-array setting is one invalid entry`: `{ userFolders: 'x' }` gives `entries.length === 1`, with `entries[0].index === null` and `entries[0].error` equal to `error`. `{ userFolders: null }` gives the default.
  - `save() writes only userFolders`: `save({ userFolder: '/a', userFolders: ['/b'] })` writes a file with no `userFolder` key. `save({ userFolders: ['rel'] })` rejects with `ERR_INVALID_CONFIG`. After a reload, `userFolders()` matches what was saved.
  - Every logic test passes `platform: 'linux'` and a POSIX `home` (`'/home/x'`) so it also runs on Windows. The win32 behaviour has its own tests with `home: 'C:\\Users\\x'`.
  - `setUserFolders writes userFolders and drops userFolder; null drops both`: start the file at `{ userFolder: '~/a', defaults: {} }`. After `setUserFolders(['~/b'])` the file is `{ defaults: {}, userFolders: ['~/b'] }` and `userFolders()` reflects it. After `setUserFolders(null)` the file is `{ defaults: {} }`.
  - Update the existing `the default user folder is ~/.prompt-cockpit…` test to also assert `resolveUserFolders({}, { home }).entries[0].resolved`.

- [ ] **Step 2: Run them to make sure they fail**
  Run: `node --test tests/superagent-config.test.mjs`
  Expected: FAIL (`resolveUserFolders` is not exported).

- [ ] **Step 3: Implement** `resolveUserFolders`, `planUserFolders` and the three config methods. Remove `userFolder()`, `checkUserFolder()` and `setUserFolder()`. Compare paths with `path.win32.resolve(p).toLowerCase()` on win32 and `path.posix.resolve(p)` elsewhere, stripping a trailing separator. In `save()`, validate `candidate.userFolders` (when it is not undefined/null) with `resolveUserFolders`. Push `{ path: 'userFolders[<i>]', message }` for each entry error, or `{ path: 'userFolders', message }` for the whole-setting error. When `userFolders` is present, delete `userFolder` from the candidate before writing and caching. Keep the old `userFolder` check only for a candidate that has the legacy key alone.

- [ ] **Step 4: Run the tests** - `node --test tests/superagent-config.test.mjs`, expected PASS.

- [ ] **Step 5: Commit** - `git add src/superagent/config.js tests/superagent-config.test.mjs` and `git commit -m "feat(superagent): userFolders list in config.json, legacy userFolder read as one item"`

---

### Task 2: `workflows.js` - one layer per user folder, shadow report, prompt lookup

**Files:**
- Modify: `src/superagent/workflows.js` (`resolvePromptPath` ~70, `evaluate` ~155, `loadWorkflows` ~327-383)
- Test: `tests/superagent-workflows.test.mjs` (inside or beside `loader contract`)

**Interfaces:**
- Consumes: Task 1's `Entry` shape.
- Produces:
  - `resolvePromptPath(role, { …, userPromptsDirs = [] })`. This replaces `userPromptsDir`; it tries each directory in order and returns `{ source: 'user', path, folder }` for the first hit.
  - `loadWorkflows({ builtinDir, globalDir, userFolders = [], projectDir, fileConfig, projectPath, fsImpl, platform })`. `userFolders: Entry[]` replaces `userDir`/`userError`. It returns `{ workflows, default, defaultNote, shadowed }`.
    - Every listed user entry carries `folder: <resolved>` (`null` for non-user sources).
    - `shadowed` is the entries that lost to a higher layer: `{ ...entry without doc, shadowedBy: { source, folder } }`.
  - The `user` layers are evaluated from the last folder to the first, so index 0 is the last to set `winner`. Layer identity is `source + folder`, both for the winner check and for the duplicate count.
  - Duplicates are marked on every entry before the winner split, so a duplicate in a losing folder keeps its errors in `shadowed`.
  - An `Entry` with `error` becomes one invalid entry `{ id: null, source: 'user', folder: null, name: <configured as text>, readError: 'the workflows folder setting is invalid: <error>' }`, as today. The global ordering of `workflows` in the result stays built-in, global, user (index 0 first), project.

- [ ] **Step 1: Write the failing tests** (reuse `setup()`; add `userA = path.join(root, 'ua')` and `userB = path.join(root, 'ub')` as `Entry`s `{ index, configured: p, resolved: p, error: null }`):
  - `the higher user folder wins and the lower copy is reported shadowed`: put `x` in both `ua/workflows` and `ub/workflows`, then load with `userFolders: [A, B]`. `byId(workflows, 'x')` gives exactly one entry, with `folder === userA`. `shadowed` has `x` from `userB` with `shadowedBy` equal to `{ source: 'user', folder: userA }`.
  - `an invalid higher copy still shadows a valid lower one`: `ua` has `x` with `format: 9`, `ub` has a valid `x`. Only `ua`'s `x` is listed, `valid: false`. `ub`'s `x` is in `shadowed`.
  - `duplicates inside one folder name the folder`: two files with id `x` in `ua` are both invalid, with a message equal to `duplicate id "x" in the user workflows of ${userA}`, and they shadow a valid `x` in `ub`.
  - `duplicates in a losing folder stay invalid`: a valid `x` in `ua` and two `x` files in `ub`. Both `ub` copies are in `shadowed` with `valid: false` and the duplicate error.
  - `a user folder shadows global`: global `x` and `ua` `x` give the user one listed and the global one in `shadowed`.
  - `an invalid folder setting is one invalid entry and hides nothing`: `userFolders: [{ index: 0, configured: 'rel', resolved: null, error: 'bad' }, B]` lists one `user` entry with `id: null`, plus `ub`'s workflows.
  - `resolvePromptPath tries user folders in order`: `ua/prompts/tester.md` and `ub/prompts/tester.md` with `userPromptsDirs: [ua/prompts, ub/prompts]` give `path` under `ua`. Without the `ua` file it gives `ub`.
  - Rename any existing `userPromptsDir`/`userDir` uses in this file (there are none today; grep to confirm).

- [ ] **Step 2: Run them to make sure they fail** - `node --test tests/superagent-workflows.test.mjs`, expected FAIL.

- [ ] **Step 3: Implement** the signature changes above. `ctx.userPromptsDirs` is `userFolders.filter(e => !e.error).map(e => path.join(e.resolved, 'prompts'))`.

- [ ] **Step 4: Run the tests** - `node --test tests/superagent-workflows.test.mjs`, expected PASS.

- [ ] **Step 5: Commit** - `git commit -m "feat(superagent): one workflow layer per user folder, first folder wins, shadowed entries reported"`

---

### Task 3: `store.js` and `prompts.js` - jobs carry `userFolders`

**Files:**
- Modify: `src/superagent/store.js:77`, `src/superagent/prompts.js:43-60,255`
- Test: `tests/superagent-store.test.mjs` (~572), `tests/superagent-prompts.test.mjs`

**Interfaces:**
- Consumes: Task 2's `resolvePromptPath({ userPromptsDirs })`.
- Produces:
  - `deriveJob(...).userFolders: string[]`. The `userFolder` field is removed from the derived job.
  - `hasTemplate(role, { projectDir, recordedPrompt = null, userFolders = [] })`.
  - `buildWorkerPrompt` reads `job.userFolders`.

- [ ] **Step 1: Write the failing tests**
  - Store: `legacy userFolder becomes a one-item list`. A `job-created` with `userFolder: '/u'` gives `job.userFolders` equal to `['/u']`. With `userFolders: ['/a', '/b']` it gives that list. With `userFolders: ['/a', null, 3]` it gives `['/a']`. With neither it gives `[]`. Update the test at ~572 to destructure `userFolders` and assert `[]`.
  - Store + prompts: `an old job-created replays to the old folder`. Replay logs through `deriveJob` and then `buildWorkerPrompt`, with `userFolder: <dir>` (a string), with `userFolder: null`, and with no field. Only the string one renders the marker from `<dir>/prompts/<role>.md`. A log with both `userFolders: []` and `userFolder: <dir>` uses no folder.
  - Prompts: `buildWorkerPrompt takes the first user folder that has the role`. Use a job with `userFolders: [a, b]` where only `b/prompts/<role>.md` exists. The rendered prompt contains `b`'s marker text. Add `a/prompts/<role>.md` and it contains `a`'s marker. Follow the file's existing `buildWorkerPrompt` test setup.

- [ ] **Step 2: Run them to make sure they fail** - `node --test tests/superagent-store.test.mjs tests/superagent-prompts.test.mjs`, expected FAIL.

- [ ] **Step 3: Implement.** `resolveTemplate`/`loadRoleTemplate`/`hasTemplate` take `userFolders` and map it to `userPromptsDirs`.

- [ ] **Step 4: Run the tests** - same command, expected PASS.

- [ ] **Step 5: Commit** - `git commit -m "feat(superagent): jobs record and read an ordered userFolders list"`

---

### Task 4: Supervisor - `createJob`, `settings()`, `setUserFolders()`

**Files:**
- Modify: `src/superagent/index.js:771-838` (snapshot, `loadWorkflowList`, `settings`, `setUserFolder`), `:884` (`hasTemplate`), `:1048-1090` (`createJob`/`admitJob` record), and the `return` at ~1374 (export `setUserFolders`, drop `setUserFolder`)
- Test: `tests/superagent.test.mjs` (harness at ~42 and new tests)

**Interfaces:**
- Consumes: Task 1's `config.userFolders()`, `config.planUserFolders()`, `config.setUserFolders()`; Task 2's `loadWorkflows({ userFolders })` and `shadowed`; Task 3's `hasTemplate({ userFolders })`.
- Produces:
  - `settings() -> { isDefault, default, error, folders: Row[] }`. `Row` is:
    - user folder rows: `{ index, configured, resolved, error, exists, fixed: false, workflows: WItem[], prompts: PItem[], note }`
    - then one global row: `{ index: null, configured: null, resolved: <globalDir>, error: null, exists, fixed: true, workflows, prompts: [], note }`
  - `WItem = { id, name, file, valid, errors, description, status: 'used' | 'shadowed' | 'invalid', shadowedBy: string | null }`. `status` is `shadowed` when the entry is in `shadowed`, else `invalid` when `!valid`, else `used`. `shadowedBy` is the winner's `folder` (or `globalDir` when the winner is global).
  - `PItem = { file, role, status: 'used' | 'shadowed' | 'ignored', shadowedBy: string | null, reason: string | null }`.
    - `ignored` has reason `the contract is built in` (for `contract.md`) or `not a role name`.
    - Status comes from the real lookup, not from file names. For a usable role, call `resolvePromptPath(role, { userPromptsDirs, builtinDir })` once and compare its `path` to this file (case-folded on win32).
      - The winner is `used`.
      - Any other copy is `shadowed`, with `shadowedBy` set to the winner's folder.
      - A lookup that throws (e.g. `EACCES`) sets that row's `note` and marks the file `ignored` with reason `could not be read: <message>`.
  - `setUserFolders(list: string[] | null) -> settings()`.
    - `null` calls `config.setUserFolders(null)`.
    - Otherwise it runs `config.planUserFolders(list)`. A plan error throws `ERR_INVALID_REQUEST` with that message.
    - Calls are serialised on one in-process promise chain (`settingsChain`): one POST's plan, folder creation and write all finish before the next POST plans. The owner lock means no other process writes `config.json` through the supervisor.
    - For each `isNew` entry it runs `mkdir` on the folder, `workflows/` and `prompts/` (`ERR_INVALID_FOLDER` `could not create <path>: <msg>`, before any write). Then it calls `config.setUserFolders(list)`.
  - `job-created` carries `userFolders` (the valid entries' resolved paths, in order) and no longer `userFolder`.

- [ ] **Step 1: Harness isolation.** Pass a temp `home` to `createSuperagentConfig` in `tests/superagent.test.mjs:42` (`home: root`), `tests/superagent-inplace.test.mjs:46` and `tests/superagent-stop-provisioning.test.mjs:41`. Grep `createSuperagentConfig(` across `tests/` for any other call without `home` and fix it the same way.

- [ ] **Step 2: Write the failing tests**
  - `createJob records userFolders in order, skipping invalid entries`: config `{ userFolders: [<root>/u1, 'relative', <root>/u2] }`. The `job-created` event has `userFolders` equal to `[u1, u2]` and no `userFolder` key.
  - `settings lists each folder with used, shadowed and invalid items`: `u1/workflows/x.json` (valid), `u2/workflows/x.json` (valid), `u2/workflows/broken.json` (`{`), global `y.json`, `u1/prompts/tester.md`, `u2/prompts/tester.md`, `u2/prompts/contract.md`. Expect:
    - `folders.map(f => f.fixed)` is `[false, false, true]`
    - u1's `x` has status `used`, u2's `x` has status `shadowed` with `shadowedBy === u1`
    - u2's `broken.json` has status `invalid`
    - global `y` has status `used`
    - u2's `tester.md` has status `shadowed`, u1's has status `used`
    - `contract.md` has status `ignored` with reason `the contract is built in`
  - `setUserFolders keeps stored entries as-is`: stored `[<root>/gone, 'relative']` (neither exists, one invalid). `setUserFolders(['relative', <root>/gone, <root>/new])` resolves, and only `<root>/new/workflows` and `<root>/new/prompts` exist afterwards (`<root>/gone` is still absent). The file's `userFolders` equals the sent list.
  - `setUserFolders refuses a duplicate new folder`: stored `[<root>/a]`. `setUserFolders([<root>/a, <root>/a/])` rejects with `code === 'ERR_INVALID_REQUEST'`, and the file is unchanged.
  - `setUserFolders leaves config.json untouched when a folder cannot be created`: put a file where the folder should be. The call rejects with `ERR_INVALID_FOLDER` and the file bytes are unchanged.
  - `setUserFolders(null) resets to the default`: `settings().isDefault === true`.
  - `overlapping setUserFolders calls do not lose a write`: stored `[]`. Start `setUserFolders([a])` and `setUserFolders([a, b])` without awaiting the first. After both settle, the file equals the second list and both folders exist.
  - `a non-array setting shows as one invalid row and hides nothing`: config `{ userFolders: 'x' }`. `settings().folders[0].error` is set, the global row still lists its workflows, and `listWorkflows()` has one invalid `user` entry plus the built-ins.
  - `a prompt that differs only by case is shadowed on win32`: skip unless `process.platform === 'win32'`. With `u1/prompts/Tester.md` and `u2/prompts/tester.md`, u1's is `used` and u2's is `shadowed`.

- [ ] **Step 3: Run them to make sure they fail** - `node --test tests/superagent.test.mjs`, expected FAIL on the new tests.

- [ ] **Step 4: Implement.** Replace `userFolderSnapshot()` with `config.userFolders().entries`, read once per `createJob`/`listWorkflows`/`settings` call. Pass the valid entries' resolved paths to `hasTemplate`. In `settings()`, read each valid folder's `prompts/*.md` (keep today's `ENOENT`/`ENOTDIR` silence; any other error sets that row's `note`). Find `exists` with `stat(...).isDirectory()`.

- [ ] **Step 5: Run the touched files** - `node --test tests/superagent.test.mjs tests/superagent-inplace.test.mjs tests/superagent-stop-provisioning.test.mjs`, expected PASS. The full suite runs after Task 5, once the route calls `setUserFolders`.

- [ ] **Step 6: Commit** - `git commit -m "feat(superagent): settings() lists every folder with shadowing; setUserFolders keeps stored entries"`

---

### Task 5: Route - `POST /api/superagent/settings` takes `userFolders`

**Files:**
- Modify: `src/routes/superagent.js:268-279`
- Test: `tests/superagent-routes.test.mjs` (use `fakeHost({ supervisor: { setUserFolders } })`)

**Interfaces:**
- Consumes: Task 4's `supervisor.setUserFolders(list | null)`.

- [ ] **Step 1: Write the failing tests**
  - `POST settings passes userFolders through`: posting `{ userFolders: ['/a', '/b'] }` gives 200, and the fake receives `['/a', '/b']`. Posting `{ userFolders: null }` makes the fake receive `null`.
  - `POST settings refuses any other body`: each of `{}`, `{ userFolder: '/a' }`, `{ userFolders: '/a' }`, `{ userFolders: ['/a', 3] }` and `{ userFolders: [], x: 1 }` gives 400 with `code: 'ERR_INVALID_REQUEST'` and `error: 'userFolders must be a list of paths or null'`.
  - `POST settings maps ERR_INVALID_FOLDER to 400`: the fake throws `{ code: 'ERR_INVALID_FOLDER' }`, and the response is 400. Check that `respondError` already maps it; add the mapping only if it doesn't.

- [ ] **Step 2: Run them to make sure they fail** - `node --test tests/superagent-routes.test.mjs`, expected FAIL.

- [ ] **Step 3: Implement** the body check and the call.

- [ ] **Step 4: Run the full suite** - `npm test`, expected PASS.

- [ ] **Step 5: Commit** - `git commit -m "feat(superagent): settings route takes an ordered userFolders list"`

---

### Task 6: Settings dialog - folder list, collapsible lists, docs

**Files:**
- Modify: `public/superagent-settings.js`, `public/superagent-view.js:480-542`, `public/index.html:255-273`, `public/style-superagent.css`
- Create: `tests/superagent-settings.test.mjs`
- Modify (docs): `CLAUDE.md` (the **User folder (2026-11-26)** paragraph and the `superagent-settings.js` mentions), `tests/README.md` (the settings dialog entry)

**Interfaces:**
- Consumes: Task 4's `settings()` shape.
- Produces (pure, in `public/superagent-settings.js`):
  - `settingsSummary(settings) -> { isDefault, defaultPath, error, list: string[], rows: SummaryRow[] }`
    - `list` is the stored strings sent back on the next POST: the `configured` of every non-fixed row whose `configured` is a string.
    - `SummaryRow = { listIndex, title, fixed, status: 'ok' | 'missing' | 'error', statusText, canUp, canDown, canRemove, workflows: { label, status, detail }[], prompts: { label, status, detail }[] }`
    - `listIndex` is the row's position in `list`, which is what move and remove act on. It is `null` for the global row, a non-string stored entry and the whole-setting error row.
      - Those rows have `canUp`/`canDown` false.
      - Only a non-string entry has `canRemove` true. Removing it posts `list` unchanged, which drops it.
    - The global row has `title` `${resolved} (global, workflows only)` and `canUp`/`canDown`/`canRemove` false.
    - `detail` text:
      - `used`: workflows give their description; prompts give `Used for the <role> role`
      - `shadowed`: `Shadowed by <shadowedBy>`
      - `invalid`: the first error, as today's `firstError`
      - `ignored`: `Ignored: <reason>`
  - `moveFolder(list, index, delta) -> string[]`, `removeFolder(list, index) -> string[]`, `addFolder(list, value) -> string[]` (appends the trimmed value). All three return a new array; out-of-range input returns a copy unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/superagent-settings.test.mjs` (import `../public/superagent-settings.js`):
  - `settingsSummary keeps stored strings and drops non-strings from the list`: rows with `configured` `'/a'`, `7`, `'/b'`, plus the global row, give `list` `['/a', '/b']`.
  - `the global row is fixed`: its `canUp`, `canDown` and `canRemove` are false, and its title ends with `(global, workflows only)`.
  - `first row cannot move up, last user row cannot move down`.
  - `listIndex skips non-string entries`: stored `['/a', 7, '/b']` gives `/b` `listIndex: 1`. `removeFolder(list, 1)` gives `['/a']`, and `moveFolder(list, 1, -1)` gives `['/b', '/a']`.
  - `item details by status`: check one of each status against the strings above.
  - `moveFolder/removeFolder/addFolder`: `moveFolder(['a','b','c'], 2, -1)` gives `['a','c','b']`, `moveFolder(['a'], 0, -1)` gives `['a']`, `removeFolder(['a','b'], 0)` gives `['b']`, `addFolder(['a'], '  b ')` gives `['a','b']`.

- [ ] **Step 2: Run them to make sure they fail** - `node --test tests/superagent-settings.test.mjs`, expected FAIL.

- [ ] **Step 3: Implement the pure helpers.**

- [ ] **Step 4: Run the tests** - same command, expected PASS.

- [ ] **Step 5: Dialog markup and wiring.**
  - In `index.html`, replace the single input and the Save/Use default buttons with:
    - `#superagentSettingsBody` (the folder rows)
    - an add row (`#superagentSettingsAddInput` text field, `#superagentSettingsAdd` button)
    - a note: `The first folder wins when two folders have the same workflow or prompt. Project overrides in <project>/.superpowers/superagent/ beat every folder listed here. Jobs already created keep the folders they started with.`
    - Close (the Save and "Use default" buttons are removed, per the spec; delete their handlers)
  - In `superagent-view.js`:
    - Render each row as a `<details class="sa-folder">`. The `<summary>` holds the title, the status text and ↑/↓/✕ buttons; the buttons call `event.preventDefault()` so clicking them doesn't toggle the row.
    - Inside each row, add two nested `<details>`: `Workflows (n)` and `Prompts (n)`, each holding a `ul.sa-list`. When a list is empty, write `No .json files in its workflows/ folder.` or `No .md files in its prompts/ folder.` instead of "None found."
    - While a POST is in flight, every add, move and remove control is disabled. They are re-enabled after the response or error has been rendered.
    - Each action POSTs `{ userFolders: <new list> }` through the existing `saveSettings` path (renamed to take a list), re-renders from the response, and keeps the `workflowFor = null` refresh of the New-job picker.
    - Keep which rows are open across a re-render, keyed by `resolved`.
  - In CSS, style the rows with the existing `sa-*` tokens. Confirm `.modal-box > .modal-body` (`style-overlays.css:119-120`) still scrolls; give the body `overflow-y: auto` explicitly only if it doesn't.

- [ ] **Step 6: Hand-verify in the app.** Run `npm start`, open `/?view=superagent` and click Settings. Then check:
  1. The global row shows `fg-level` as used.
  2. Add a second folder and confirm it is created with `workflows/` and `prompts/`.
  3. Copy a workflow into both user folders and confirm the lower copy reads "Shadowed by …".
  4. Reorder and confirm the shadowing flips.
  5. Remove a folder.
  6. Add enough rows to overflow and confirm the body scrolls while the footer stays visible.
  7. Add a duplicate folder and confirm the error line shows.

- [ ] **Step 7: Docs.**
  - Rewrite CLAUDE.md's **User folder** paragraph for `userFolders`. Cover: the ordered list and its precedence; the legacy read; the `[]` vs unset default; per-entry validation; `planUserFolders` keeping stored entries; `job-created.userFolders` and `deriveJob`'s fallback; `settings()`'s rows with `status`/`shadowedBy`; the POST body and error text; and the dialog.
  - Fix CLAUDE.md's claim that the `superagent.test.mjs` harness sets `home` so it is now true.
  - Update `tests/README.md`'s settings entry: the pure helpers are now unit-tested, the dialog wiring is still hand-verified.
  - Grep for leftover `userFolder\b`, `setUserFolder\b`, `checkUserFolder`, `userPromptsDir\b` and `userDir` in `src public tests CLAUDE.md tests/README.md backlog.md`. The only hits left should be the legacy-read code and its tests.

- [ ] **Step 8: Run the full suite** - `npm test`, expected PASS.

- [ ] **Step 9: Commit** - `git commit -m "feat(superagent): Settings dialog lists every folder with add, remove, reorder and collapsible workflows and prompts"`
