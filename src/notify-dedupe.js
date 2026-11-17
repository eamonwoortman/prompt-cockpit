// Shared verbatim with the browser via static-files.js's SHARED_SRC_FILES - no
// Node-only imports, no DOM globals at import time (storage and locks are injected).
const STORAGE_KEY = 'cockpit:notifiedKeys';
const LOCK_NAME = 'cockpit:notify';

// The record is pruned to the current entries, except keys `keep` accepts: a
// source whose entries are not authoritative yet (the superagent while it
// boots) keeps its keys, so they do not count as new once it is ready.
export function planNotifications({ entries, record, firstPoll, keep = () => false }) {
  const known = new Set(record);
  const notify = firstPoll ? [] : entries.filter((entry) => !known.has(entry.key));
  const current = entries.map((entry) => entry.key);
  const present = new Set(current);
  return { notify, record: [...current, ...record.filter((key) => !present.has(key) && keep(key))] };
}

function readRecord(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function claimNotifications({ entries, firstPoll, storage, locks, keep }) {
  const claim = async () => {
    let raw = null;
    try {
      raw = await storage.getItem(STORAGE_KEY);
    } catch {}
    const plan = planNotifications({ entries, record: readRecord(raw), firstPoll, keep });
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(plan.record));
    } catch {}
    return plan.notify;
  };
  return locks ? locks.request(LOCK_NAME, claim) : claim();
}
