// Turns the error that ended a session into text a person can act on. The raw
// stack trace used to go straight to the browser; now only a readable message
// does, and the stack is handed back separately so the server can log it.
// Provider-neutral on purpose: it matches the failure's wording, not a provider
// id, and quotes the provider's own message so nothing is hidden.

// An exhausted prepaid/usage balance: HTTP 402 "Payment Required", or wording
// like "usage balance exhausted" / "insufficient credits".
const BALANCE_EXHAUSTED = /\b402\b|payment required|balance (?:is )?exhausted|insufficient (?:balance|credits|funds)/i;

export function describeSessionError(err) {
  const raw = String((err && err.message) || err || '').trim();
  const detail = String((err && err.stack) || raw || 'Unknown error');
  if (BALANCE_EXHAUSTED.test(raw)) {
    return {
      kind: 'balance',
      text: 'The provider says your usage balance is exhausted, so this session has ended. '
        + 'Top up or wait for the balance to reset, then start a new session.\n\n'
        + `Provider message: ${raw}`,
      detail,
    };
  }
  const text = raw && raw !== '[object Object]' ? raw : 'Unknown error';
  return { kind: 'generic', text, detail };
}
