// The hooks go in before init() so a Ctrl-C during boot still stops the host
// (init is cancellable) and still releases the owner lock after sessions close.
// Like wireAutopilot, call it only from inside listen()'s success callback: a
// second `npm start` on a taken port must die before it can contend for the lock.
export function wireSuperagent({ shutdown, host, logImpl = console.error }) {
  shutdown.onBeforeClose(() => host.stop());
  shutdown.onAfterClose(() => host.afterClose());
  return Promise.resolve()
    .then(() => host.init())
    .catch((err) => logImpl(`superagent init failed: ${String(err?.message || err)}`));
}
