# Changesets

Packages published to npm (`@easytestdata/core`, `@easytestdata/qbo-client`,
`@easytestdata/shared`, `@easytestdata/server` and `easytestdata`)
are versioned together with [Changesets](https://github.com/changesets/changesets).

If your pull request changes one of them in a way users will notice, run `pnpm changeset`, pick
the bump (patch, minor, major), and describe the change in one sentence. Commit the generated
file with your PR. Docs-only or internal changes don't need a changeset.
