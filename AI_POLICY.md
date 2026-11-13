# AI policy

turno is a tool for running coding agents, and it is built with their help. Using AI tools to
contribute is fine. These rules keep the review load fair for a single maintainer.

1. **You are responsible for every line.** Read, understand and test what you submit. "The
   model wrote it" is not an answer to a review question.
2. **Write issues and pull request descriptions in your own words.** Short and specific beats
   long and generated. Machine translation is welcome: put the original text in a quoted
   block below the translation.
3. **Declare AI use** in the pull request template checkbox. Do not add `Co-Authored-By`,
   `Assisted-by` or "Generated with" trailers to commits; the commit hook rejects them, and the
   only author of a commit is the person who signs it off.
4. **No autonomous agents** opening issues, pull requests or comments. A human starts each
   contribution and answers the review.
5. **Security reports** follow the AI clause in [SECURITY.md](SECURITY.md): say so, verify it,
   send a real proof of concept.

Contributions that ignore these rules may be closed without review. Repeated low-effort
submissions are treated under the [Code of Conduct](CODE_OF_CONDUCT.md).

Inspired by the AI policies of Astral and curl.
