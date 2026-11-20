import type { Ctx } from "./context.js";

/**
 * What a login saved, in words: the sites the person opened (the agent starts with their
 * cookies), or that nothing was opened, so nothing new was signed in.
 */
export function loginSummary(c: Ctx, id: string, sites: readonly string[]): string {
  if (!sites.length)
    return `Closed. No site was opened, so no new sign-in was saved. Open one directly with ${c.names.identity("login", id)} --url https://mail.example.com`;
  const shown = sites.length > 4 ? `${sites.slice(0, 4).join(", ")} and ${sites.length - 4} more` : sites.join(", ");
  return `Saved. Sites you opened: ${shown}. The agent starts with the same cookies on them.`;
}
