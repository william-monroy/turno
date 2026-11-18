import { join } from "node:path";
import { browserPaths as paths } from "turno-core/paths";

/**
 * Identity ids and where each identity lives. A browser identity is a persistent Chrome user
 * data dir under `<data>/browser/identities/<id>`, its settings in `<id>.json` next to it, and
 * what turno-browser writes while it runs (generated config, runtime lock, session health,
 * reputation log) under `<state>/browser/identities/<id>`.
 */

const IDENTITY_ID = /^[a-z0-9][a-z0-9_-]*$/;

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export function isValidIdentityId(id: string): boolean {
  return IDENTITY_ID.test(id) && id.length <= 64;
}

export function assertIdentityId(id: string): void {
  if (!isValidIdentityId(id)) {
    throw new IdentityError(`invalid identity "${id}": use lowercase letters, digits, "-" and "_", starting with a letter or digit`);
  }
}

/** The identity's Chrome profile (user data dir). */
export function identityDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertIdentityId(id);
  return join(paths(env).identitiesDir, id);
}

/** What turno-browser writes for the identity while it runs, outside the Chrome profile. */
export function identityStateDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertIdentityId(id);
  return join(paths(env).identityStateDir, id);
}
