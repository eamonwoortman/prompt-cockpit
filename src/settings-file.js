// Shared read/write for a project's `.claude/settings.local.json` - the
// personal, gitignored-by-convention override file (per the SDK's own
// settings-precedence note: user < project < local < flag < policy).
// plugin-settings.js and session-defaults.js both store their own top-level
// key in this same file rather than each opening/parsing it independently,
// so a concurrent write from one doesn't clobber a concurrent write from the
// other and every other key already in the file (hooks, permissions,
// whatever the user has in there) always round-trips untouched.
//
// The atomic-write, corrupt-file-refusal and per-path serialized
// read-modify-write machinery this relies on now lives in json-store.js,
// shared with cockpit's own files under ~/.prompt-cockpit. This module keeps
// the cwd -> settings-path knowledge and nothing else; its public API is
// unchanged.
import path from 'node:path';
import { readJson, updateJson } from './json-store.js';

export function settingsPath(cwd) {
  return path.join(cwd, '.claude', 'settings.local.json');
}

export async function readSettingsFile(cwd) {
  return readJson(settingsPath(cwd));
}

// Serialization is keyed on the resolved settings-file path rather than the
// resolved cwd, which is the same grouping (one settings file per cwd) - so
// a plugin toggle and a thinking-budget change for one project still queue
// up behind each other exactly as before.
export async function updateSettingsFile(cwd, mutator) {
  return updateJson(settingsPath(cwd), mutator);
}
