# 0059. Chrome's cookie key: the mock keychain stays the default, the system keychain per identity

Date: 2026-11-18. Status: accepted. Stage 5 of the wave 7 architecture review; builds on
ADR 0044 (identity.json) and ADR 0055 (session export and import).

## Context

Playwright (and patchright, which turno-browser drives) starts Chrome with
`--use-mock-keychain` on macOS and `--password-store=basic` on Linux. Chrome encrypts its
cookie values (and saved passwords) with a key it gets from the OS: on macOS the "Chrome Safe
Storage" item in the login Keychain, on Linux the Secret Service or KWallet. The two switches
replace that key with a fixed one, so Chrome never touches the OS store.

The question for stage 5 was whether an identity's Chrome should keep the mock keychain.

### Measured (macOS 26, Google Chrome 157, patchright-core 1.64.3, 2026-11-18)

A headless Chrome started the way turno-browser starts it, on a temporary profile with a
temporary HOME, visited a 127.0.0.1 page that set one cookie:

- Chrome's command line carried `--use-mock-keychain`.
- The cookie's `value` column was empty and `encrypted_value` started with `v10`.
- `encrypted_value` decrypted with AES-128-CBC under PBKDF2-HMAC-SHA1(`mock_password`,
  `saltysalt`, 1003 iterations), the key every mock-keychain Chrome uses; the plaintext was the
  cookie's value. The Linux `peanuts` key and an empty password did not decrypt it.
- Launch to a usable context: about 0.7 s.

So with the mock keychain, an identity's cookies are as good as plaintext on disk: anyone who
can read the profile folder can read the sessions, without the user's Keychain. The folder's
owner-only mode is the only protection.

### Not measured

Chrome without `--use-mock-keychain` reads, and on first use creates, "Chrome Safe Storage" in
the user's login Keychain. Running it here would have read or written a real Keychain item,
which the rules for this work forbid (tests use fake stores or temporary keychain files only),
and a temporary keychain cannot stand in: Chrome looks the item up on the user's search list.
What it does is documented from Chromium's source (`components/os_crypt`,
`crypto/apple_keychain`) instead:

- The key is a random password stored in that item; Chrome derives the AES key from it the same
  way (PBKDF2, `saltysalt`, 1003). Cookie values are `v10` with that key.
- The item's access list names Google Chrome, so a Chrome started by turno (the same signed
  binary) reads it without a prompt when the user's own Chrome created it; on a Mac where it
  does not exist yet, the first start creates it. A Chrome from another path (Chrome for
  Testing, Chromium) is a different app and macOS asks for Keychain access in a dialog.
- Every Chrome profile on the machine that uses the system keychain shares that one key.

On Linux without `--password-store=basic`, Chrome uses the Secret Service ("Chrome Safe
Storage" there too) when a session bus and a keyring are available, `v11` values, and falls
back to `peanuts` without them.

## Decision

**Keep the mock keychain as the default, and add a per-identity setting for the system one.**

- `identity.json` gets `keychain: "mock" | "system"` (format 3; a file without it is `mock`).
  `system` drops `--use-mock-keychain` and `--password-store=basic` from Chrome's command line
  (`ignoreDefaultArgs`) everywhere turno starts the identity's Chrome: the MCP server, `turno
  browser login`, session export and import.
- The default stays `mock`. Both settings have real uses, and nothing measured here says the
  system keychain works unattended for every user:
  - `mock`: no Keychain dialog ever, which a headless server, an agent session or a CI runner
    cannot answer; the same behavior on every machine; the profile folder can be moved between
    machines. The cost is at-rest exposure, measured above.
  - `system`: cookies on disk are encrypted with a key that is not public, so a copy of the
    profile folder (a backup, a synced folder, a stolen disk image without the Keychain) does
    not hand over the sessions. The cost is the user's Keychain in the loop (a dialog on some
    setups, a shared key with the user's own Chrome) and a profile tied to this machine.
- Changing the setting of an identity that has sessions makes its stored cookies unreadable
  (they were encrypted under the other key), so the identity starts signed out. `turno browser
  export`, then the change, then `turno browser import` carries the sessions over: the export
  holds decrypted state and the import writes it under the new key.
- It is set in identity.json (`"keychain": "system"`); `turno browser show` names it.
  A `--keychain` flag for `turno browser set` comes with the identity set flags of the
  maintenance stage, which owns that command's flags.

## Consequences

- Nothing changes for existing identities.
- A user who keeps identities on a shared or backed-up disk can opt into `system` per identity.
- SECURITY.md's table says what the default means: the identity folder holds live sessions in a
  form any process running as the user can read.
- Measuring `system` on a real Mac (launch time, whether a dialog appears with Google Chrome and
  with Chrome for Testing) is left to a person on their own machine; the ADR records that it
  was not measured here.
