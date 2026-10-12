import { EventEmitter } from "node:events";

export const accountEvents = new EventEmitter();
accountEvents.setMaxListeners(100);

/**
 * Emit an account change event across the application.
 * Listened by SSE endpoints to push instant updates to the frontend.
 */
export function notifyAccountChanged(accountId = null, action = "update") {
  try {
    accountEvents.emit("change", {
      accountId,
      action,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[accountEvents] Failed to emit change event:", err);
  }
}
