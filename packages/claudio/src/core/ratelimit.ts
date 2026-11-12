/**
 * Parsing of the StopFailure hook payload that Claude Code sends when a request fails.
 * Only real usage limits mark an account as exhausted; a passing 429 does not.
 */
export interface HookPayload {
  error?: unknown;
  error_type?: unknown;
}

const LIMIT = /usage limit|limit reached|limit resets|resets/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function isUsageLimit(payload: HookPayload): boolean {
  return payload.error_type === "rate_limit" && LIMIT.test(String(payload.error ?? ""));
}

/**
 * Epoch seconds when the limit resets. Understands "...|1762900000" and
 * "resets [on] [Nov 13,] [at] 5[:30] pm". Falls back to now + 1 h.
 */
export function resetTime(error: string, now: Date = new Date()): number {
  const nowS = now.getTime() / 1000;
  const epoch = /\|(\d{10})\b/.exec(error);
  if (epoch) {
    const t = Number(epoch[1]);
    return t > nowS ? t : nowS + 3600;
  }
  const m =
    /resets?\s+(?:on\s+)?(?:([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(error);
  if (!m) return nowS + 3600;
  const [, mon, day, hourS, minuteS, ampm] = m;
  const hour = (Number(hourS) % 12) + (ampm?.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(minuteS ?? 0);
  const dt = new Date(now);
  dt.setSeconds(0, 0);
  dt.setHours(hour, minute);
  if (mon && day) {
    const month = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
    if (month >= 0) dt.setMonth(month, Number(day));
    if (dt.getTime() / 1000 < nowS - 86400) dt.setFullYear(dt.getFullYear() + 1);
  } else if (dt.getTime() / 1000 <= nowS) {
    dt.setDate(dt.getDate() + 1);
  }
  const t = dt.getTime() / 1000;
  return t > nowS ? t : nowS + 3600;
}
