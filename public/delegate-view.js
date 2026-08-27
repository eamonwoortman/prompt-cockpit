// Cross-session delegation (`/ask <Name>: <text>`) message rendering - split
// out of stream-view.js as the frontend counterpart to src/delegation.js's
// server-side split. Takes appendBlock/closeGroup as constructor params
// (same dependency-injection shape createDelegation() uses server-side) so
// this module never imports stream-view.js back - stream-view.js is the one
// importing this, never the reverse.
//
// session-registry.js wraps both directions of the exchange in a
// self-identifying prose header before pushing them as a plain user turn -
// "[Prompt Cockpit] Relayed task from "..."" going out (delegateTask),
// "[Prompt Cockpit] Relayed reply from "..."" coming back
// (relayDelegationResult), both followed by an explanatory paragraph, a
// `\n---\n` separator, then the actual payload. Without unwrapping here, the
// bubble would show "You" for a turn neither side's human actually typed.
// (Earlier version of this wrapper used an XML-ish `<delegated_task from=
// "...">` tag - dropped 2026-08-20 because receiving models were pattern-
// matching it as a spoofed tool-scaffolding tag and refusing it outright;
// see session-registry.js's buildDelegatedHeader comment.)
// No unescaping needed here (unlike the old tag shape) - the server no
// longer HTML-escapes the payload, and this renders via textContent
// downstream regardless, never as markup.
const DELEGATED_HEADER_RE = /^\[Prompt Cockpit\] Relayed (task|reply) from "([^"]*)"\n\n[\s\S]*?\n---\n([\s\S]*)$/;

export function createDelegateView({ appendBlock, closeGroup }) {
  // Delegated-reply bubbles awaiting a possible cockpit:delegate-full-trace
  // marker (session-registry.js's relayDelegationResult) - container ->
  // Map<queueId, roleRowEl>. The marker, when it comes, always arrives AFTER
  // the bubble it belongs to (relayDelegationResult pushes the turn - which
  // echoes synchronously, see session.js's pushInput - before it broadcasts
  // the marker), live or replayed alike, so there's no "marker beats bubble"
  // race to handle here, only "marker never comes" (the common case: no extra
  // content beyond the clean answer, see relayDelegationResult).
  const delegatedBubblesByContainer = new WeakMap();

  // Call once per fresh session view (stream-view.js's resetStreamView does
  // this) so stale bubble references from a previous session don't linger.
  function reset(container) {
    delegatedBubblesByContainer.set(container, new Map());
  }

  // `kind` distinguishes the two delegation directions so the caller can style
  // them differently: a 'task' is real input to THIS session (the operator
  // relayed another human's typed message in) - it stays a "user" bubble, blue
  // box and all. A 'reply' is the opposite - another session's own answer,
  // forwarded back - so it renders like an assistant response, not like
  // something typed here.
  function delegatedLabelAndText(text) {
    const match = DELEGATED_HEADER_RE.exec(text);
    if (match) return { kind: match[1], label: match[2], text: match[3] };
    return null;
  }

  // Remembers a just-rendered delegated-reply bubble so a later
  // cockpit:delegate-full-trace marker (see attachDelegatedTrace below) can
  // find it again. `queueId` is null for anything that isn't this session's
  // own live pushInput echo (a historical/replayed array-content block, say) -
  // harmless no-op, since relayDelegationResult only ever mints a matching
  // marker for a queueId it minted itself.
  function registerDelegatedReplyBubble(container, queueId, wrap) {
    if (queueId == null) return;
    if (!delegatedBubblesByContainer.has(container)) delegatedBubblesByContainer.set(container, new Map());
    delegatedBubblesByContainer.get(container).set(queueId, wrap);
  }

  // cockpit:delegate-full-trace marker handler - adds a small corner button to
  // the matching delegated-reply bubble that opens the full (narration-
  // included) text in the detail pane, via onShowDelegatedTrace (app.js ->
  // detail-pane.js's showText). No bubble found is a silent no-op, not an
  // error: the marker always arrives after its bubble (session-registry.js's
  // relayDelegationResult comment), so a miss here would mean the bubble's
  // own container got reset/replaced in between - the marker is just stale at
  // that point, nothing to attach to.
  function attachDelegatedTrace(container, queueId, label, text, onShowDelegatedTrace) {
    const bubbles = delegatedBubblesByContainer.get(container);
    const wrap = bubbles?.get(queueId);
    if (!wrap) return;
    const roleRow = wrap.querySelector(':scope > .role');
    if (roleRow) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'trace-toggle-btn';
      btn.textContent = '⤢ Expand answer';
      btn.title = 'Show the full reply (narration included) - by default only the final answer is relayed into this session';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onShowDelegatedTrace?.(container, queueId, label, text);
      });
      roleRow.append(btn);
    }
    bubbles.delete(queueId); // one marker per bubble - nothing left to match if another somehow arrived for the same id
  }

  // renderMessage's 'cockpit:delegate-sent' case - cockpit-only marker, never
  // a real SDK message, appended straight to the origin's own eventLog by
  // session-registry.js's delegateTask so it survives reconnect. Minimal/
  // textual per the confirmed v1 scope - no special styling beyond the
  // existing 'system' block class.
  function renderDelegateSent(container, message, timestampMs) {
    closeGroup(container);
    return appendBlock(container, 'system', 'Delegated', `-> Asked ${message.targetName}: ${message.text}`, [], container, null, null, timestampMs);
  }

  // renderMessage's 'cockpit:delegate-full-trace' case - cockpit-only marker,
  // never a real SDK message, appended straight to the origin's own eventLog
  // by session-registry.js's relayDelegationResult so it survives reconnect.
  // Purely additive UI: attaches a button to an already-rendered bubble,
  // renders nothing of its own.
  function renderDelegateFullTrace(container, message, onShowDelegatedTrace) {
    return attachDelegatedTrace(container, message.queueId, message.label, message.text, onShowDelegatedTrace);
  }

  return {
    reset,
    delegatedLabelAndText,
    registerDelegatedReplyBubble,
    renderDelegateSent,
    renderDelegateFullTrace,
  };
}
