// Is anyone at the computer? Overnight chaining runs on its own only while
// the user is away; while they are here a rate limit shows the ask-me button
// instead. Two signals, both server-wide (there is one user per cockpit):
//   - activity pings: browser tabs report real interaction (keys, pointer)
//     while focused and visible; an open but ignored tab sends nothing.
//   - a manual "away" switch that forces away regardless of recent activity.
// In-memory on purpose: a restart resets it. With no activity ever recorded
// (nobody has touched a tab since the server started) the answer is "away".
let lastActivityAt = 0;
let forcedAway = false;

export const DEFAULT_AWAY_MINUTES = 10;

export function markActivity(now = Date.now()) {
  lastActivityAt = now;
}

export function setForcedAway(value) {
  forcedAway = Boolean(value);
}

export function isForcedAway() {
  return forcedAway;
}

// `awayMinutes` of silence from every tab means away. With no ping ever
// recorded (server just started, nobody has touched a tab) that is away too.
export function isAway(awayMinutes = DEFAULT_AWAY_MINUTES, now = Date.now()) {
  if (forcedAway) return true;
  return now - lastActivityAt >= awayMinutes * 60_000;
}

export function _reset() {
  lastActivityAt = 0;
  forcedAway = false;
}
