// The bell's one feed: auto-pilot's entries first, then superagent's. Both are
// derived from live state, never stored (autopilot.js's notifications(),
// superagent/notifications.js via the host), so there is nothing to mark read.
import { respondJson } from '../http-utils.js';

export function registerNotificationRoutes(router, { autopilot, host }) {
  router.get('/api/notifications', async (req, res) => {
    const { entries } = await autopilot.notifications();
    return respondJson(res, 200, { entries: [...entries, ...host.notifications()] });
  });
}
