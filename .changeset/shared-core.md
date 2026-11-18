---
"turno-core": minor
"turno-cli": patch
"turno-browser": patch
---

New package `turno-core` with what turno-cli and turno-browser share: turno's paths, the secret
store (macOS Keychain, Linux Secret Service) and the process helpers (ADR 0053). Both packages
now depend on it instead of keeping their own copies; behavior is unchanged.
