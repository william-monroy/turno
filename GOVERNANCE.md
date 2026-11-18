# Governance

turno has a single maintainer who has the final say (a "benevolent dictator" model). That keeps
decisions fast while the project is small; this file will change if more maintainers join.

## How decisions are made

- **Small changes** (fixes, docs, refactors that change no behavior) are decided in the pull
  request.
- **Features** start as an issue. The maintainer labels it `accepted` or explains why not.
- **Large changes** go through an issue labeled `rfc`: a new agent adapter, a change to the
  config format, the security model, a command that breaks, a new runtime dependency. The
  discussion stays open for at least a week, and the maintainer closes it with the outcome
  (context, decision, consequences). Closed `rfc` issues are the project's memory: read them
  before proposing to undo one.

## Roles

- **Maintainer**: reviews and merges, cuts releases (from CI only), owns the npm packages and
  the GitHub organization.
- **Backup administrator**: holds admin rights on the GitHub organization and the npm
  packages so the project survives if the maintainer disappears, and receives code of conduct
  reports about the maintainer. Named here before the first public release.
- **Contributors**: anyone who opens an issue, a discussion or a pull request.

## Releases

Releases come from CI through Changesets ([docs/RELEASING.md](docs/RELEASING.md)). No one
publishes from a laptop.

## Pull request limits

To keep review sustainable, users without write access may have a limited number of open pull
requests at a time (GitHub's open pull request limit). Stale issues are not closed by a bot.
