// Shared verbatim with the browser via static-files.js's SHARED_SRC_FILES - no
// Node-only imports, no DOM globals at import time (storage and locks are injected).
const STORAGE_KEY = 'cockpit:notifiedKeys';
const LOCK_NAME = 'cockpit:notify';

export function planNotifications({ entries, record, firstPoll }) {
  const known = new Set(record);
  const notify = firstPoll ? [] : entries.filter((entry) => !known.has(entry.key));
  return { notify, record: entries.map((entry) => entry.key) };
}

function readRecord(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function claimNotifications({ entries, firstPoll, storage, locks }) {
  const claim = async () => {
    const record = readRecord(await storage.getItem(STORAGE_KEY));
    const plan = planNotifications({ entries, record, firstPoll });
    storage.setItem(STORAGE_KEY, JSON.stringify(plan.record));
    return plan.notify;
  };
  return locks ? locks.request(LOCK_NAME, claim) : claim();
}
