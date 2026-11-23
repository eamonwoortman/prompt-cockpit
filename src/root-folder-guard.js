// Best-effort Windows command guard. Keep the command recognizers here so
// their scope can be adjusted without changing provider integrations.
import path from 'node:path';
import { stat } from 'node:fs/promises';

export const ROOT_FOLDER_DENIAL = 'Never create a folder at the root of a drive. Use %TEMP% or a proper gitignored folder. If a root folder is necessary, ask the user to create it.';

export async function rootFolderGuard(command, cwd, { platform = process.platform, statPath = stat } = {}) {
  if (platform !== 'win32' || typeof command !== 'string') return null;
  // Recognize literal targets of common shell directory-creation commands.
  // Scripts, variables, aliases and commands not sent for approval can bypass it.
  const pattern = /\b(mkdir|md|new-item)\b\s+([^\r\n;&|]+)/gi;
  for (const match of command.matchAll(pattern)) {
    const args = match[2];
    if (/^new-item$/i.test(match[1]) && !/(?:-itemtype\s+directory|-type\s+directory)/i.test(args)) continue;
    const tokens = args.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].replace(/^['"]|['"]$/g, '');
      if (/^-(?:itemtype|type)$/i.test(token)) { i++; continue; }
      if (/^[-/]/.test(token) || /[%$*?`]/.test(token)) continue;
      const full = path.win32.resolve(cwd || '', token);
      if (!/^[a-z]:\\/i.test(full)) continue;
      const root = path.win32.parse(full).root;
      const first = full.slice(root.length).split('\\')[0];
      if (!first) continue;
      const top = path.win32.join(root, first);
      try { if ((await statPath(top)).isDirectory()) continue; } catch { /* missing or inaccessible: deny */ }
      return ROOT_FOLDER_DENIAL;
    }
  }
  return null;
}
