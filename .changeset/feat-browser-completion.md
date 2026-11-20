---
"turno-browser": minor
"turno-core": minor
---

`turno-browser completion <zsh|bash|fish>` prints a shell completion script: commands, identity
names, setup agents, `do` actions and each command's flags. It only reads identity folders, so
completing never starts Chrome or reads the secret store. The scripts come from turno-core, which
turno uses too.
