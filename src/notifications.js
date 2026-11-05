// The notification bell: what moved on OTHER pages since you last looked - a page that came back
// with a new version, an agent that replied, a page that was opened for you. Pure over event-log
// entries, so it is testable without a server; the route reads the log's tail and adds titles.
//
// One row per page, its latest event: three rewrites of one page are one "came back", not three.
// Thread pages are left out - their replies already count in the threads footer - and so is the
// page the reader is on, which shows its own updates.

/** @type {Record<string, string>} */
export const NOTIFICATION_LABELS = Object.freeze({
  "page.version": "New version",
  "page.agent_reply": "Agent replied",
  "page.opened": "New page",
});

/** @param {any} event */
export function isNotificationEvent(event) {
  if (!event || !(event.type in NOTIFICATION_LABELS)) return false;
  // a reopen of a page you already had is not news
  return event.type !== "page.opened" || event.data?.new === true;
}

/**
 * @param {any[]} events oldest first, the event log's envelopes
 * @param {{ exclude?: string, threadKeys?: Set<string>, limit?: number }} [options]
 * @returns {{ key: string, type: string, label: string, at: string }[]} newest first
 */
export function summarizeActivity(events, { exclude = "", threadKeys = new Set(), limit = 30 } = {}) {
  const latest = new Map();
  for (const event of events) {
    if (!isNotificationEvent(event)) continue;
    const key = String(event.subject || "");
    if (!key || key === exclude || threadKeys.has(key)) continue;
    latest.delete(key);
    latest.set(key, { key, type: event.type, label: NOTIFICATION_LABELS[event.type], at: String(event.ts || "") });
  }
  return [...latest.values()].reverse().slice(0, limit);
}
