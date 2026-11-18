# 0055. Encrypted session export and import for browser identities

Date: 2026-11-18. Status: accepted. Stage 5 of the wave 7 architecture review; builds on
ADR 0044 (browser identities), ADR 0047 (the turno-browser API) and ADR 0054 (the vault).

## Context

A browser identity's sessions live in its Chrome profile. Moving them is hard: the profile is
tied to the Chrome version and, through the cookie key (ADR 0059), to the machine; copying the
folder also copies caches, history and extensions state. Sessions are needed elsewhere: a
second machine, another turno account (the same person runs several, and a project can move
between them), or a short-lived backup before a risky change such as switching the cookie key.

## Decision

**`turno browser export <id> --out <file>` and `turno browser import <file> [--as <id>]`.**

- **What.** Playwright's storage state with IndexedDB (`context.storageState({ indexedDB:
  true })`): cookies, localStorage and IndexedDB of every origin. Playwright reads storage only
  for origins the context opened since it started, so export first lists the origins the
  profile holds storage for (IndexedDB folder names, the origin keys of the Local Storage
  database, the cookies' hosts) and opens each one in a page whose requests are all answered
  locally with an empty document: nothing goes to the network. Import applies it with
  `context.setStorageState`, which first clears the identity's cookies and storage, so the
  identity ends up with exactly the exported session. Both open the identity's Chrome headless,
  with its identity.json settings and its keychain setting, under its runtime lock (refused
  while a server or a login window holds it).
- **Never the vault.** The vault's values are in the secret store, which export does not read;
  the browser profile holds no vault value (browser_login fills forms, it does not save
  passwords in Chrome). A test exports an identity with vault credentials and checks that
  neither value is in the decrypted payload.
- **Encryption.** A passphrase (at least 12 characters) goes through scrypt (N 2^17, r 8, p 1,
  a random 16-byte salt) to a 256-bit key; AES-256-GCM with a random 12-byte IV encrypts the
  payload. The file is one JSON document: format, version, KDF parameters, cipher, IV,
  ciphertext and tag. The header is the GCM additional data, so changing it (say, lowering the
  KDF cost) fails like a wrong passphrase. Import refuses KDF parameters past a ceiling (N up to
  2^20, r up to 32, p up to 16) before deriving anything, so a crafted file cannot make it
  allocate gigabytes. No dependency: `node:crypto` has all of it.
- **Expiry inside.** The payload holds `createdAt` and `expiresAt` (default 7 days, at most
  90, `--expires 12h|7d`); import refuses an expired export. Inside the ciphertext, the date
  cannot be moved without the passphrase.
- **Passphrase input.** A hidden prompt on a terminal (asked twice on export), otherwise the
  first line of stdin; never a flag. With `--no-input` or in an agent session a prompt is not
  shown; the command says to pass it on stdin.
- **The file.** Written with mode 600, never over an existing file without `--force`.
- **Import into an existing identity** asks first (its current sessions are lost), or needs
  `--yes`; a new identity is created without asking. `--dry-run` decrypts and shows what would
  happen. The import clears the identity's last session health result, so the next start checks
  the sign-in again.
- **API.** turno-browser's API gains `exportSession`, `readSessionExport` and `importSession`:
  version 1.2, which turno-cli now requires.

## Alternatives considered

- **Copying the profile folder.** Carries everything, including what should not move, breaks
  across Chrome versions and, with the system keychain, across machines.
- **A key from the secret store instead of a passphrase.** It would tie the file to this
  machine's store, which defeats moving it.
- **Argon2id.** Stronger against GPU attacks than scrypt, but `node:crypto` only has it in the
  newest Node versions, and a dependency would go against the lean install (ADR 0019). scrypt
  at 2^17 is the OWASP recommendation for scrypt.

## Consequences

- A signed-in identity can move between machines and turno accounts without signing in again,
  as long as the sites accept the cookies elsewhere (some bind sessions to an IP or device).
- An export is a bearer credential for every site in it until it expires; the expiry and the
  passphrase are what protect it. SECURITY.md lists it.
- The real-Chrome test exports cookies, localStorage and IndexedDB from one identity and reads
  them back in another.
