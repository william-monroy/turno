---
"turno-browser": minor
"turno-cli": minor
---

`turno browser export <id> --out <file>` and `turno browser import <file> [--as <id>]` move an
identity's cookies, localStorage and IndexedDB as one file encrypted with a passphrase (scrypt
and AES-256-GCM), refused after its expiry and never holding vault credentials.
`"keychain": "system"` in identity.json makes Chrome encrypt an identity's cookies with the OS
keychain instead of Playwright's fixed mock key; the default is unchanged.
turno-browser's API is now 1.2, which this turno requires.
