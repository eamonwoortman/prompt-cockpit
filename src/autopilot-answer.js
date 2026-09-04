// Turns an AskUserQuestionInput into the exact answer payload the cockpit's
// own client already sends, so an unattended pilot can keep going instead of
// parking on a question forever.
//
// Pure: no I/O, no clock, no registry. The scoping decision (which rows may
// be auto-answered) lives in autopilot.js; this module only knows how to
// choose.
//
// Input shape, from the SDK's own types
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:855 onwards):
// questions[] of { question, header, multiSelect (REQUIRED boolean),
// options[] of { label, description, preview? } }. Output shape from
// public/approval-panel.js:184-190: { questions, answers }, with `answers`
// keyed by the EXACT question text.
export const RECOMMENDED_RE = /\(recommended\)/i;

export function buildAutoAnswer(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : null;
  if (!questions || questions.length === 0) return null;

  // Collected as [text, label] pairs, not assigned onto a plain object as
  // we go - `answers[text] = label` has two failure modes for a question
  // text this module cannot actually answer: a literal `'__proto__'` hits
  // Object.prototype's own setter (silently discarded, no own property
  // created - a real key just vanishes with no error), and a duplicate
  // `text` across two questions silently overwrites the first, understating
  // what was actually asked in the resulting `chosen`/'answered' log entry.
  // Object.fromEntries below defines real own properties for every pair
  // (including one literally named "__proto__"), so it isn't vulnerable to
  // the same setter - collecting entries here just lets duplicates be
  // detected first and refused, rather than silently losing information.
  const entries = [];
  const seen = new Set();
  const chosen = [];
  for (const q of questions) {
    const text = typeof q?.question === 'string' ? q.question : '';
    const options = Array.isArray(q?.options) ? q.options : [];
    if (!text || options.length === 0) return null;
    // Two questions with the same exact text can't be told apart in the
    // `answers` map the client itself uses (keyed by question text) - not a
    // shape this module can answer, so it falls through to a human rather
    // than silently answering only one of them.
    if (seen.has(text)) return null;
    seen.add(text);
    // The option the model itself flagged, else the first - which is the
    // convention the tool's own guidance establishes ("make that the first
    // option in the list and add '(Recommended)'").
    const pick = options.find((o) => RECOMMENDED_RE.test(String(o?.label ?? ''))) || options[0];
    const label = String(pick?.label ?? '');
    if (!label) return null;
    // For multiSelect: true the rule is UNCHANGED - one option, not all of
    // them. The client joins multiple selections with ', ' (approval-panel.js
    // :188); a single selection needs no join, and "recommended" never means
    // "everything".
    entries.push([text, label]);
    chosen.push({ question: text, chosenLabel: label });
  }

  return {
    decision: { behavior: 'allow', updatedInput: { questions, answers: Object.fromEntries(entries) } },
    chosen,
  };
}
