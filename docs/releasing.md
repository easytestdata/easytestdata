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

### First release (one time)

Publishing uses npm trusted publishing (GitHub Actions OIDC) instead of a stored token. npm only
lets you add a trusted publisher to a package that already exists, so the very first publish
uses a short-lived token.

Before the first push to `easytestdata/easytestdata` (so the release workflow finds what it needs):

1. **GitHub:** in the repository settings, create an environment named `npm-publish` (optionally
   with required reviewers).
2. **npmjs.com:** create a granular access token (Access Tokens > Generate New Token > Granular):
   read and write, packages and scopes `@easytestdata` and `easytestdata`, expiry 7 days.
3. **GitHub:** save it as the `NPM_TOKEN` secret of the `npm-publish` environment.

The first push to `main`:

4. The release workflow builds, tests and, with no pending changesets, publishes 0.1.0 of all five
   packages with provenance. This also claims the unscoped `easytestdata` name.
5. Check each package page on npmjs.com (`easytestdata`, `@easytestdata/core`,
   `@easytestdata/qbo-client`, `@easytestdata/shared`, `@easytestdata/server`): version 0.1.0,
   README, license and a provenance badge.

Right after the first publish:

6. **npmjs.com:** for each of the five packages, open **Settings > Trusted publisher**, choose
   GitHub Actions, and enter owner `easytestdata`, repository `easytestdata`, workflow
   `release.yml`, and environment `npm-publish`.
7. **npmjs.com:** in each package's **Settings > Publishing access**, choose "Require two-factor
   authentication and disallow tokens".
8. **GitHub:** delete the `NPM_TOKEN` secret, and revoke the token on npmjs.com.

Trusted publishing needs npm 11.5.1 or later, so the release workflow installs it before
publishing (a Node 24 release may bundle an older npm); `pnpm publish` (pnpm 9) hands the actual
upload to that npm. Check the first release's log shows npm 11.5.1+ before deleting the token. From then on every release is the
Version packages pull request described above.
