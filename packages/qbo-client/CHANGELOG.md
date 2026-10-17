# @easytestdata/qbo-client

## 0.4.0

### Minor Changes

- 1bb8f90: Server extensions can register job kinds (`jobs` on a descriptor) that the shared job runner runs
  in the QuickBooks lane; a `needsSandbox` job receives a locked, sandbox-only target object.
  `@easytestdata/server/extension` adds `enqueueExtensionJob`, `getExtensionJob` and
  `cancelExtensionJob`. `@easytestdata/qbo-client` adds `clearSandbox`. Migration
  `002_extension_jobs.sql` adds the `extension` job type.

### Patch Changes

- 2cd0c3e: Extension jobs close their sandbox target as soon as the handler settles, decide cancelled
  versus failed in one database update, count sandbox activity only when a request is sent (a new `onRequestSent` QboClient option), and
  replace a result only when it cannot be saved as JSON. Batch create, update and delete failures
  now include QuickBooks' error `Detail`.
- @easytestdata/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [5f2b05b]
  - @easytestdata/core@0.3.0

## 0.2.0

### Patch Changes

- @easytestdata/core@0.2.0

## 0.1.1

### Patch Changes

- @easytestdata/core@0.1.1

## 0.1.0

First public release.
