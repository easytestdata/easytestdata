# @easytestdata/shared

## 0.4.0

### Minor Changes

- 1bb8f90: Server extensions can register job kinds (`jobs` on a descriptor) that the shared job runner runs
  in the QuickBooks lane; a `needsSandbox` job receives a locked, sandbox-only target object.
  `@easytestdata/server/extension` adds `enqueueExtensionJob`, `getExtensionJob` and
  `cancelExtensionJob`. `@easytestdata/qbo-client` adds `clearSandbox`. Migration
  `002_extension_jobs.sql` adds the `extension` job type.

## 0.3.0

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.1

No changes in this release.

## 0.1.0

First public release.
