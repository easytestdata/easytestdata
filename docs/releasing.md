# Releasing

The first release is v0.1.0.

## npm packages

`@easytestdata/core`, `@easytestdata/qbo-client`, `@easytestdata/shared`, `@easytestdata/server`
(which ships the built web app for `easytestdata ui`) and the `easytestdata` CLI are versioned
together with [Changesets](https://github.com/changesets/changesets). Everything else
in the monorepo is private and never published.

1. Contributors add a changeset (`pnpm changeset`) to pull requests that change a published package.
2. On every push to `main`, the [release workflow](../.github/workflows/release.yml) opens or updates
   a **Version packages** pull request that bumps versions and writes the changelogs.
3. Merging that pull request publishes the new versions to npm with provenance and creates GitHub
   releases.

### How publishing is authenticated

There is no npm token. Each package has a trusted publisher on npmjs.com (**Settings > Trusted
publisher**): GitHub Actions, owner `easytestdata`, repository `easytestdata`, workflow
`release.yml`, environment `npm-publish`, with "Allow npm publish" ticked (unticked, npm only
accepts staged publishes and the release step fails). npm accepts a publish only from that
workflow running in that environment, and the workflow's `id-token: write` permission is what
lets it prove this.

Trusted publishing needs npm 11.5.1 or later, so the release workflow installs it before
publishing (a Node 24 release may bundle an older npm); `pnpm publish` (pnpm 9) hands the actual
upload to that npm.

A new published package needs a trusted publisher too, and npm only lets you add one to a
package that already exists: publish its first version by hand from its directory with
`pnpm publish --access public` (pnpm, so `workspace:` versions are rewritten; npm asks for your
account's two-factor code), then add the trusted publisher with the values above.
