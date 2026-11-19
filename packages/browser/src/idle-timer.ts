import type { IdleTimerLike, McpConfig } from "./upstream.js";

/** Upstream's default idle limit for a headless browser it owns (`defaultIdleTimeout`). */
const HEADLESS_IDLE_MS = 60 * 60 * 1000;

/** Upstream's `IdleTimer`: every tool call restarts the countdown. */
export class IdleTimer implements IdleTimerLike {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {}
  poke(): void {
    this.dispose();
    this.timer = setTimeout(this.onIdle, this.ms);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** The idle limit of a browser turno starts or attaches to: the config's, else upstream's headless default. */
export function idleMs(config: McpConfig): number | undefined {
  return config.timeouts?.idle ?? (config.browser.launchOptions.headless ? HEADLESS_IDLE_MS : undefined);
}
