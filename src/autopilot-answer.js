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

  const answers = {};
  const chosen = [];
  for (const q of questions) {
    const text = typeof q?.question === 'string' ? q.question : '';
    const options = Array.isArray(q?.options) ? q.options : [];
    if (!text || options.length === 0) return null;
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
    answers[text] = label;
    chosen.push({ question: text, chosenLabel: label });
  }

  return {
    decision: { behavior: 'allow', updatedInput: { questions, answers } },
    chosen,
  };
}
