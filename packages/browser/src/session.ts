/**
 * The client session mcpd relays a call for. mcpd puts an opaque id, stable for one
 * client session and different for every other, in the `_meta` of each `tools/call` it
 * forwards, under this key. The host reads it and hands it to turno tools; nothing else
 * depends on it yet (a later stage keys per-tab locks on it).
 */
export const SESSION_META_KEY = "io.turno/session";

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
