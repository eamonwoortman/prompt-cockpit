// The bell's one feed: auto-pilot's entries first, then superagent's. Both are
// derived from live state, never stored (autopilot.js's notifications(),
// superagent/notifications.js via the host), so there is nothing to mark read.
//
// `superagentReady` says whether the superagent entries are the full list
// (host.notificationsReady()). While it is false a superagent key missing from
// `entries` may only be not loaded yet, so the browser keeps it in its
// notified-keys record (public/notifications-panel.js). One source that throws
// is logged and served as empty; the other still reaches the bell.
import { respondJson } from '../http-utils.js';

export function registerNotificationRoutes(router, { autopilot, host, logImpl = console.error }) {
  async function fromSource(name, read) {
    try {
      return await read();
    } catch (err) {
      logImpl(`${name} notifications failed: ${String(err?.message || err)}`);
      return [];
    }
  }

  router.get('/api/notifications', async (req, res) => {
    const pilotEntries = await fromSource('auto-pilot', async () => (await autopilot.notifications()).entries);
    let superagentReady = false;
    const superagentEntries = await fromSource('superagent', () => {
      const entries = host.notifications();
      superagentReady = host.notificationsReady();
      return entries;
    });
    return respondJson(res, 200, { entries: [...pilotEntries, ...superagentEntries], superagentReady });
  });
}
