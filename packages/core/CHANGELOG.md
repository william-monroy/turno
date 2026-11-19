# turno-core

## 0.1.0

### Minor Changes

- a0bfce8: New package `turno-core` with what turno-cli and turno-browser share: turno's paths, the secret
  store (macOS Keychain, Linux Secret Service) and the process helpers. Both packages
  now depend on it instead of keeping their own copies; behavior is unchanged.

### Patch Changes

- 2948759: The package homepage is now https://turno.wimo.dev.
- 5566437: Every package has a README that tells the same story as the site. turno-cli's follows the
  order of turno.wimo.dev and lists what the browser gained; turno-browser's is organized around
  what the package does (identities, the credential vault, session export and import, tab limits,
  `browser_batch`, blocking and cache, health and doctor); turno-core's says what the shared
  package is for; turno-fonts' shows the status line and how `turno ui install` uses the font.
  Each links to its page on turno.wimo.dev and to the releases.
