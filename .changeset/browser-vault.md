---
"turno-browser": minor
"turno-cli": minor
---

Credential vault for browser identities: `turno browser vault add|list|remove|submit`
stores a username, a password and an optional TOTP secret per site in the OS secret store, and
the new `browser_login` tool fills them into the site's sign-in page without the agent ever
seeing them. Results and errors are redacted, values are bound to the site's origins, and the
form is submitted only when the identity opts in. turno-browser's API is now 1.1, which this
turno requires.
