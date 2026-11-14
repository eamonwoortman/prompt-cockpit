// Browser drop/paste uploads: a screenshot or file has no real path the
// server can see, so the bytes are saved under the session's cwd and the
// compose box references them with a normal `@path`. Every provider can then
// read them with its own file tools - no provider-specific attachment format.
import fs from 'node:fs/promises';
import path from 'node:path';

export const UPLOAD_DIR = path.join('.claude', 'cockpit-uploads');
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class UploadTooLargeError extends Error {}

// Basename only, no path separators or control chars, bounded length. A name
// that sanitizes to nothing falls back to a generic one.
export function sanitizeUploadName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const cleaned = base.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').trim().slice(-100);
  return cleaned || 'upload';
}

export async function readRawBody(req, limit = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  // Past the limit the rest is read and discarded rather than the socket
  // destroyed, so the route's 413 reply still reaches the browser.
  let exceeded = false;
  for await (const chunk of req) {
    total += chunk.length;
    if (exceeded || total > limit) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (exceeded) throw new UploadTooLargeError(`upload exceeds ${limit / (1024 * 1024)}MB limit`);
  return Buffer.concat(chunks);
}

// Returns the cwd-relative path (forward slashes) of the saved file. The
// directory carries its own `*` .gitignore so uploads never show up as
// untracked files in the user's repo, whatever their root .gitignore says.
export async function saveUpload(cwd, name, data, now = Date.now()) {
  const dir = path.join(cwd, UPLOAD_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'w' });
  const file = `${now}-${sanitizeUploadName(name)}`;
  await fs.writeFile(path.join(dir, file), data);
  return path.posix.join(...UPLOAD_DIR.split(path.sep), file);
}
