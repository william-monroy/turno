/**
 * What a call to the accounts bridge may do (ADR 0024): whether the user must confirm it, and
 * which tools the delegated run gets. The decision depends on the account, never on the
 * caller's word alone: `write=false` only narrows the tools when the account lists read tools.
 */

/** When the user must confirm a delegated run. */
export type ConfirmPolicy = "always" | "writes" | "never";

export const CONFIRM_POLICIES: readonly ConfirmPolicy[] = ["always", "writes", "never"];

export function isConfirmPolicy(v: unknown): v is ConfirmPolicy {
  return typeof v === "string" && (CONFIRM_POLICIES as readonly string[]).includes(v);
}

/**
 * Mail and messaging services: reading them hands another account's private conversations to
 * the calling session, so every call is confirmed unless the account says otherwise.
 */
const MESSAGING = new Set([
  "chat",
  "discord",
  "email",
  "exchange",
  "gchat",
  "google-chat",
  "imessage",
  "matrix",
  "mattermost",
  "messages",
  "messenger",
  "outlook",
  "signal",
  "slack",
  "sms",
  "teams",
  "telegram",
  "whatsapp",
  "zulip",
]);

function isMessagingService(service: string): boolean {
  return MESSAGING.has(service) || service.includes("mail");
}

/** The default policy of a service: `always` for mail and messaging, `writes` elsewhere. */
export function defaultConfirm(service: string): ConfirmPolicy {
  return isMessagingService(service) ? "always" : "writes";
}

/** Whether the tool pattern `pattern` (with an optional trailing `*`) covers `tool`. */
export function patternCovers(pattern: string, tool: string): boolean {
  if (pattern === tool) return true;
  return pattern.endsWith("*") && tool.startsWith(pattern.slice(0, -1));
}

/** The fields of an account the policy reads. */
export interface PolicyAccount {
  service: string;
  tools: string[];
  readTools?: string[];
  confirm?: ConfirmPolicy;
}

export interface Decision {
  /** The policy in force: the account's own, or the service default. */
  policy: ConfirmPolicy;
  /** The user must confirm before anything runs. */
  confirm: boolean;
  /** `read`: only the account's read tools; `all`: every tool of the account. */
  toolset: "read" | "all";
  /** The tool patterns the delegated run may call (passed as --allowedTools). */
  tools: string[];
  /** One line on why, for the confirmation form and the audit log. */
  reason: string;
}

export function effectivePolicy(account: PolicyAccount): ConfirmPolicy {
  return account.confirm ?? defaultConfirm(account.service);
}

/**
 * Decide a call. A read gets only the read tools when the account lists them; without them a
 * read cannot be enforced, so it is treated like a write (all tools, confirmed unless the
 * policy is `never`).
 */
export function decide(account: PolicyAccount, write: boolean): Decision {
  const policy = effectivePolicy(account);
  const readTools = account.readTools ?? [];
  if (!write && readTools.length > 0) {
    return {
      policy,
      confirm: policy === "always",
      toolset: "read",
      tools: [...readTools],
      reason: policy === "always" ? `read with the read tools; confirm = "always"` : "read with the read tools only",
    };
  }
  const reason = write
    ? "write: every tool of the account"
    : "read, but the account lists no read_tools, so it gets every tool";
  return {
    policy,
    confirm: policy !== "never",
    toolset: "all",
    tools: [...account.tools],
    reason: policy === "never" ? `${reason}; confirm = "never"` : reason,
  };
}
