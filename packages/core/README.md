# turno-core

The building blocks that [turno-cli](https://www.npmjs.com/package/turno-cli) and
[turno-browser](https://www.npmjs.com/package/turno-browser) share. You do not install it
yourself: both packages depend on it.

- `turno-core/paths`: turno's folders, from `HOME`, the XDG variables and `TURNO_CONFIG_DIR`,
  `TURNO_STATE_DIR`, `TURNO_DATA_DIR`; the browser's folders; private folders (0700) and files
  (0600); a `PATH` lookup.
- `turno-core/secrets`: the secret store of the machine, the macOS Keychain through `security`
  or the Linux Secret Service through `secret-tool`. Values travel on stdin, never in a process
  argument list.
- `turno-core/process`: whether a PID is alive, signals that never throw, and the process table
  with process groups.

Why it exists:
[ADR 0053](https://github.com/wimo-dev/turno/blob/main/docs/decisions/0053-shared-core-package.md).
Apache-2.0.
