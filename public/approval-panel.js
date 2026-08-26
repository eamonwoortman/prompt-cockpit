// Approval banner (plain tool-call allow/deny, ExitPlanMode's plan review,
// and AskUserQuestion's pill-form) - the one gate every tool call routes
// through (session.js's canUseTool). Owns the queue/pending-request state
// that used to be scattered module-level `let`s in app.js; nothing outside
// this module reads them (confirmed - see the 2026-08-26 review's app.js
// finding on this chunk having outgrown "wiring").
export function initApprovalPanel({
  approvalBanner,
  approvalPlain,
  approvalHeading,
  approvalDetail,
  approveBtn,
  rejectBtn,
  alwaysAllowScope,
  alwaysAllowToolName,
  planReviewControls,
  planFeedbackText,
  planNoteText,
  questionForm,
  approvalQueueCountEl,
  detailPane,
  tabChrome,
  postDecision, // async ({ requestId, decision, updatedInput, alwaysAllow, message }) => void
  sendFollowUpInput, // (text) => void - plan review's "append more before approving"
}) {
  let pendingApprovalRequestId = null;
  let pendingApprovalToolName = null; // gates planReviewControls/rejectBtn's label - only ExitPlanMode gets the plan-review treatment
  const approvalQueue = [];

  function updateApprovalQueueCount() {
    if (!approvalQueueCountEl) return;
    if (approvalQueue.length > 1) {
      approvalQueueCountEl.textContent = `1 of ${approvalQueue.length}`;
      approvalQueueCountEl.hidden = false;
    } else {
      approvalQueueCountEl.textContent = '';
      approvalQueueCountEl.hidden = true;
    }
  }

  function enqueue(request) {
    if (!request || !request.requestId) return;
    if (approvalQueue.some((r) => r.requestId === request.requestId)) return;
    approvalQueue.push(request);
    if (approvalQueue.length === 1) renderBanner(request);
    else updateApprovalQueueCount();
  }

  function renderBanner(request) {
    pendingApprovalRequestId = request.requestId;

    // Belt-and-suspenders re-measure right before the banner actually needs
    // the offset to be right, instead of only trusting whatever earlier
    // lifecycle event (session connect, resize, drag) last computed it. The
    // connect()-time call this used to rely on exclusively measures
    // #detailPane while #streamWrap may still be display:none mid-setup
    // (see detail-pane.js's syncOffset comment) - that's now patched at the
    // one call site we found, but a banner is worth getting right every time
    // it appears, not just when every upstream timing assumption holds.
    detailPane.syncOffset();

    if (request.toolName === 'AskUserQuestion' && Array.isArray(request.input?.questions)) {
      approvalPlain.hidden = true;
      renderQuestionForm(request);
      questionForm.hidden = false;
      approvalBanner.hidden = false;
      tabChrome.setNeedsAttention(true);
      updateApprovalQueueCount();
      return;
    }
    questionForm.hidden = true;
    questionForm.innerHTML = '';
    approvalPlain.hidden = false;
    alwaysAllowScope.value = ''; // never carry a stale scope into a different tool's request
    alwaysAllowToolName.textContent = request.toolName;
    alwaysAllowToolName.title = request.toolName;
    pendingApprovalToolName = request.toolName;

    const isPlan = request.toolName === 'ExitPlanMode';
    approvalHeading.textContent = isPlan
      ? 'Plan ready - approve to exit plan mode?'
      : (request.title || request.displayName || `${request.toolName}?`);
    approvalHeading.title = approvalHeading.textContent;

    approvalDetail.textContent = isPlan && request.input?.plan
      ? request.input.plan
      : JSON.stringify(request.input, null, 2);
    approvalDetail.classList.toggle('plan-detail', isPlan);

    // Plan review - preview + comment/revise, only for
    // ExitPlanMode. planFeedbackText/planNoteText always reset on a new
    // request, same as alwaysAllowScope above, so neither field leaks between
    // this plan and whatever comes after it.
    planReviewControls.hidden = !isPlan;
    planFeedbackText.value = '';
    planNoteText.value = '';
    rejectBtn.textContent = isPlan ? 'Request changes' : 'No';

    approvalBanner.hidden = false;
    tabChrome.setNeedsAttention(true); // needs a decision regardless of focus - cleared on window focus (tab-chrome.js)
    updateApprovalQueueCount();
  }

  // Builds the AskUserQuestion form: one block per question (pill-style
  // options, single-select or multi-select per `q.multiSelect`, plus a free-
  // text "Other" fallback per the tool's own description - "Users will
  // always be able to select 'Other' to provide custom text input"), and one
  // Submit for the whole set. `answers` must be keyed by the *exact* question
  // text (confirmed against the tool's own schema/checkPermissions handler -
  // see the investigation that found this) - not an index, not the header.
  function renderQuestionForm(request) {
    questionForm.innerHTML = '';
    const questions = request.input.questions || [];
    const state = new Map(); // question text -> { selected: Set<label>, otherEl }

    for (const q of questions) {
      const block = document.createElement('div');
      block.className = 'q-block';

      const text = document.createElement('div');
      text.className = 'q-text';
      text.textContent = q.header ? `${q.header}: ${q.question}` : q.question;
      block.append(text);

      const optionsEl = document.createElement('div');
      optionsEl.className = 'q-options';
      const selected = new Set();
      for (const opt of q.options || []) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'q-option';
        pill.setAttribute('aria-pressed', 'false');
        const label = document.createElement('span');
        label.textContent = opt.label;
        pill.append(label);
        if (opt.description) {
          const desc = document.createElement('span');
          desc.className = 'q-option-desc';
          desc.textContent = opt.description;
          pill.append(desc);
        }
        pill.addEventListener('click', () => {
          if (q.multiSelect) {
            pill.classList.toggle('selected');
            const on = pill.classList.contains('selected');
            pill.setAttribute('aria-pressed', on ? 'true' : 'false');
            if (on) selected.add(opt.label);
            else selected.delete(opt.label);
          } else {
            optionsEl.querySelectorAll('.q-option.selected').forEach((el) => {
              el.classList.remove('selected');
              el.setAttribute('aria-pressed', 'false');
            });
            pill.classList.add('selected');
            pill.setAttribute('aria-pressed', 'true');
            selected.clear();
            selected.add(opt.label);
          }
        });
        optionsEl.append(pill);
      }
      block.append(optionsEl);

      const other = document.createElement('input');
      other.type = 'text';
      other.className = 'q-other';
      other.placeholder = 'Other (type your own answer)…';
      block.append(other);

      questionForm.append(block);
      state.set(q.question, { selected, otherEl: other });
    }

    const actions = document.createElement('div');
    actions.className = 'q-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'q-submit';
    submitBtn.textContent = 'Submit answers';
    submitBtn.title = 'Send these answers and continue';
    questionForm.onsubmit = (event) => {
      event.preventDefault();
      const answers = {};
      for (const [questionText, { selected, otherEl }] of state) {
        const typed = otherEl.value.trim();
        if (typed) answers[questionText] = typed;
        else if (selected.size > 0) answers[questionText] = [...selected].join(', ');
      }
      sendDecision('allow', { questions, answers });
    };

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'q-skip';
    skipBtn.textContent = 'Skip';
    skipBtn.title = 'Denies the tool call outright, same as "No" on a plain approval';
    skipBtn.addEventListener('click', () => sendDecision('deny'));

    actions.append(submitBtn, skipBtn);
    questionForm.append(actions);
  }

  // One-off per action - the terminal's own "proceed? y/n", not a mode
  // change. Every gated tool call routes here now (session.js's
  // canUseTool), not just ExitPlanMode. `updatedInput` is what
  // AskUserQuestion's answer actually rides back on (see
  // renderQuestionForm) - every other caller omits it, same as before.
  // `alwaysAllow` only ever comes from approveBtn's own click
  // below - session.js strips it back off before handing the decision to the
  // SDK, it's cockpit-only bookkeeping (remembers the tool name for the rest
  // of this session, nothing persisted to disk). `message` is the plan
  // review "request changes" reason below; server.js falls back to its own
  // default when this is undefined, same as it always has for a plain deny.
  async function sendDecision(decision, updatedInput, alwaysAllow, message) {
    if (!pendingApprovalRequestId) return;
    await postDecision({ requestId: pendingApprovalRequestId, decision, updatedInput, alwaysAllow, message });
    approvalQueue.shift();
    approvalBanner.hidden = true;
    questionForm.hidden = true;
    questionForm.innerHTML = '';
    alwaysAllowScope.value = '';
    planReviewControls.hidden = true;
    pendingApprovalRequestId = null;
    pendingApprovalToolName = null;
    if (approvalQueue.length) renderBanner(approvalQueue[0]);
  }

  approveBtn.addEventListener('click', () => {
    // Captured before sendDecision resolves - pendingApprovalToolName
    // is cleared once the request is gone, and reading it after the await
    // would race a fast-arriving next approval request for a different tool.
    const note = pendingApprovalToolName === 'ExitPlanMode' ? planNoteText.value.trim() : '';
    sendDecision('allow', undefined, alwaysAllowScope.value || undefined).then(() => {
      // Plan review's "append more before approving" - queued as
      // a real follow-up turn right after approving (same ws 'input' path
      // compose.js uses, so it lands in the visible queue if a turn's already
      // running), since an `allow` PermissionResult has no message field of
      // its own for the model to see - there's nowhere else for this to ride.
      if (note) sendFollowUpInput(note);
    });
  });

  rejectBtn.addEventListener('click', () => {
    // Plan review's "request changes" - reuses the existing deny
    // path with a real reason instead of the hardcoded default: ExitPlanMode's
    // PermissionResult already carries `message` back to the model as
    // feedback, previously always "Not approved by user." regardless of why.
    const feedback = pendingApprovalToolName === 'ExitPlanMode' ? planFeedbackText.value.trim() : '';
    sendDecision('deny', undefined, false, feedback || undefined);
  });

  // Drop any in-banner request - attachClient replays the full pending
  // list. Called on every connect(), reconnect included: a second
  // overlapping prompt resolved while the socket was down would otherwise
  // still occupy queue[0].
  function reset() {
    approvalQueue.length = 0;
    pendingApprovalRequestId = null;
    pendingApprovalToolName = null;
    approvalBanner.hidden = true;
    questionForm.hidden = true;
    questionForm.innerHTML = '';
    updateApprovalQueueCount();
  }

  return { enqueue, reset };
}
