// Grok streams BPE pieces (Rac + oon). Inventing a space between every
// bare pair is what turned "Racoon" into "Rac oon". A single trailing
// newline is usually a word boundary rather than a paragraph (thinking
// chunks are often "The\n" + "user\n"); a real blank line (\n\n) is kept.
//
// Exception: that word-boundary rewrite destroys markdown. Table rows,
// list items, fences, and headings are each one line with a trailing \n,
// and turning those into spaces is what flattened Grok replies into one
// giant paragraph (and let an unclosed fence swallow the rest of the turn).
// A fenced body is worse: those lines are deliberately NOT markdown
// structure (a directory listing, Format-Table output), so the block-line
// check never fires - stripping them is what collapsed a <pre> listing
// into one horizontally-scrolling row. Keep newlines while a fence is
// still open.
//
// Shared verbatim with the browser (stream-view.js) via static-files.js
// SHARED_SRC_FILES - no Node-only imports.

const MARKDOWN_BLOCK_RE = /^\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\|)|^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

function lastLine(s) {
  const trimmed = String(s).replace(/\n+$/, '');
  const idx = trimmed.lastIndexOf('\n');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function isMarkdownBlockLine(s) {
  return MARKDOWN_BLOCK_RE.test(lastLine(s));
}

function fenceOpenerAt(str, lineStart) {
  if (str.startsWith('```', lineStart)) return '```';
  if (str.startsWith('~~~', lineStart)) return '~~~';
  return null;
}

// Same openers markdown.js uses (a line starting with ``` or ~~~). An
// unmatched opener means the cursor is still inside verbatim content.
// A ``` fence is not closed by ~~~ and vice versa.
//
// `tracker`, when passed, is a caller-owned {committedLen, open} object that
// lets this resume scanning from the last *complete* line it already saw
// instead of walking the whole buffer again. Every joinStreamText call site
// re-scans from `existing` (the buffer accumulated so far) on every
// streamed chunk - without this, a long Grok reply (~1 message per word)
// turns isInsideFence into an O(n^2) walk over the growing buffer. Commits
// only advance past a REAL newline (never the virtual end-of-string
// boundary below), so a still-open final line is always safely re-scanned
// in full next call rather than double-counted.
function isInsideFence(s, tracker) {
  const str = String(s);
  let open = tracker ? tracker.open : null;
  let lineStart = tracker && tracker.committedLen <= str.length ? tracker.committedLen : 0;
  if (tracker && lineStart === 0) tracker.open = null;
  for (let i = lineStart; i <= str.length; i++) {
    if (i === str.length || str[i] === '\n') {
      const opener = fenceOpenerAt(str, lineStart);
      if (opener) {
        if (open === null) open = opener;
        else if (open === opener) open = null;
      }
      if (tracker && i < str.length) {
        tracker.committedLen = i + 1;
        tracker.open = open;
      }
      lineStart = i + 1;
    }
  }
  return open !== null;
}

// Optional per-buffer state for the `tracker` param above. Callers that
// re-join onto the same growing buffer on every chunk (stream-view.js,
// grok-messages.js, session-registry.js's delegation buffering) should
// create one of these per buffer and pass it in on every call; a fresh
// tracker (or none) just falls back to a full rescan, so it's always safe
// to omit.
export function createFenceTracker() {
  return { committedLen: 0, open: null };
}

export function joinStreamText(existing, next, tracker) {
  const left = existing ?? '';
  const right = next ?? '';
  if (!left) return right;
  if (!right) return left;
  let a = left;
  if (a.endsWith('\n') && !a.endsWith('\n\n') && !right.startsWith('\n')) {
    const withoutNl = a.slice(0, -1);
    if (isInsideFence(withoutNl, tracker) || isMarkdownBlockLine(withoutNl) || isMarkdownBlockLine(right)) {
      return a + right;
    }
    a = withoutNl;
    if (/\s$/.test(a) || /^\s/.test(right) || /^[,.;:!?')\]}]/.test(right)) {
      return a + right;
    }
    return `${a} ${right}`;
  }
  return a + right;
}
