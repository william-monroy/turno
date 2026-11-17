---
"turno-cli": patch
---

`turno secret` refuses unknown flags and extra arguments, and `turno secret set --help` prints the usage instead of waiting for a value for a secret named `--help`.
