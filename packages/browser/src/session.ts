/**
 * The client session mcpd relays a call for. mcpd puts an opaque id, stable for one
 * client session and different for every other, in the `_meta` of each `tools/call` it
 * forwards, under this key. The host hands it to turno tools, and with `"sharing": "tabs"`
 * keys each session's backend and tab locks on it (`sharing.ts`).
 */
export const SESSION_META_KEY = "io.turno/session";

/**
 * The experimental capability a server declares in `initialize` to hear when a client session
 * ends: mcpd then sends it `SESSION_ENDED_METHOD` with `{ session: <the id above> }` for each
 * session that made a call and went away. A server without it never gets the notification.
 */
export const SESSION_CAPABILITY = "io.turno/sessions";

/** The notification mcpd sends when a client session ends (see `SESSION_CAPABILITY`). */
export const SESSION_ENDED_METHOD = "notifications/io.turno/session_ended";

/** Longest session id accepted; mcpd sends a UUID. */
const MAX_SESSION = 128;

/**
 * The session id in a request's `_meta`, or undefined when there is none or it is not a short
 * printable string (a client talking to the server directly may send anything there).
 */
export function sessionFromMeta(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[SESSION_META_KEY];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SESSION) return undefined;
  return /^[\x21-\x7e]+$/.test(value) ? value : undefined;
}
