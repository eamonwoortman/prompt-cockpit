// Per-session generation tracker so a late `result` from a force-idled turn
// cannot FIFO-steal the tag of a turn pushed after recovery.
//
// pendingResultTags (session-registry.js) is a blind shift() on every
// `result`. forceIdle fails and clears that array, then only resets local
// bookkeeping - the CLI can still emit the abandoned turn's result. If a
// new turn is tagged in between, that late result used to pop the new tag
// and relay it to the wrong origin.
//
// A drop-N counter is the wrong fix: the original reason for forceIdle is
// "a result is not coming" (pendingTurns stuck). Counting that as N=1
// swallows the next real turn. Identity, not a count.
//
// Each successful pushInput records {queueId, epoch}. forceIdle increments
// epoch and moves whatever was pending into `abandoned` (in-flight/queued
// work that may still produce a result). A result is stamped with that
// turn's epoch and `_cockpitStale` when the epoch no longer matches.
//
// Grok's runPrompt closes over the meta object and should consume() by
// identity, so a never-arriving abandoned turn cannot steal the next live
// result. Claude's SDK stream is FIFO only, so it uses consumeFifo()
// (abandoned first, then pending) plus interrupt() on forceIdle so the
// abandoned turn is expected to emit.

export function createResultEpochTracker() {
  let resultEpoch = 0;
  const pending = [];
  const abandoned = [];

  function currentMeta() {
    return abandoned[0] || pending[0] || null;
  }

  function consumeMeta(meta) {
    if (!meta) return { meta: null, stale: false, epoch: undefined, queueId: undefined };
    return {
      meta,
      stale: meta.epoch !== resultEpoch,
      epoch: meta.epoch,
      queueId: meta.queueId,
    };
  }

  function take(list, pred) {
    const i = list.findIndex(pred);
    if (i === -1) return null;
    return list.splice(i, 1)[0];
  }

  return {
    get epoch() {
      return resultEpoch;
    },
    currentMeta,
    push(queueId) {
      const meta = { queueId, epoch: resultEpoch };
      pending.push(meta);
      return meta;
    },
    remove(queueId) {
      const i = pending.findIndex((e) => e.queueId === queueId);
      if (i === -1) return false;
      pending.splice(i, 1);
      return true;
    },
    // Same pin-index-0 rule as session-registry.js's reorderPendingTagsTail:
    // pending[0] is the in-flight turn; only the tail follows queue-pane edits.
    reorderTail(queueIds) {
      const pinned = pending.length ? [pending[0]] : [];
      const tail = pending.slice(pinned.length);
      const byQueueId = new Map(tail.map((e) => [e.queueId, e]));
      const used = new Set();
      const ordered = [];
      for (const qid of queueIds) {
        const entry = byQueueId.get(qid);
        if (entry && !used.has(qid)) {
          ordered.push(entry);
          used.add(qid);
        }
      }
      for (const entry of tail) {
        if (!used.has(entry.queueId)) ordered.push(entry);
      }
      pending.length = 0;
      pending.push(...pinned, ...ordered);
    },
    forceIdle() {
      resultEpoch += 1;
      if (pending.length) abandoned.push(...pending);
      pending.length = 0;
    },
    consume(metaOrQueueId) {
      const pred = (e) => e === metaOrQueueId || e.queueId === metaOrQueueId;
      const meta = take(abandoned, pred) || take(pending, pred);
      if (meta) return consumeMeta(meta);
      if (metaOrQueueId && typeof metaOrQueueId === 'object' && 'epoch' in metaOrQueueId) {
        return consumeMeta(metaOrQueueId);
      }
      return consumeMeta(null);
    },
    consumeFifo() {
      const meta = abandoned.length ? abandoned.shift() : pending.shift();
      return consumeMeta(meta || null);
    },
    stamp(message) {
      const meta = currentMeta();
      if (meta && message && typeof message === 'object') {
        message._cockpitEpoch = meta.epoch;
        if (meta.queueId !== undefined) message._cockpitQueueId = meta.queueId;
      }
      return message;
    },
    applyResultStamp(message, consumed) {
      if (!message || typeof message !== 'object' || !consumed || !consumed.meta) return message;
      message._cockpitEpoch = consumed.epoch;
      if (consumed.queueId !== undefined) message._cockpitQueueId = consumed.queueId;
      if (consumed.stale) message._cockpitStale = true;
      return message;
    },
    snapshot() {
      return {
        resultEpoch,
        pendingTurnsMeta: pending.length,
        abandonedTurnsMeta: abandoned.length,
      };
    },
  };
}
