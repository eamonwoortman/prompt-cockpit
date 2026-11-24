// Case-sensitive on every platform: path.posix.matchesGlob folds case on Windows.
// Supports `**`, `*` and `?` only.
const compiled = new Map();

function globRegex(glob) {
  let re = compiled.get(glob);
  if (re) return re;
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      src += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`);
  compiled.set(glob, re);
  return re;
}

export function isTestPath(rel, globs) {
  const file = rel.replaceAll('\\', '/');
  const candidates = file.endsWith('.meta') ? [file, file.slice(0, -'.meta'.length)] : [file];
  return globs.some((g) => candidates.some((c) => globRegex(g).test(c)));
}
