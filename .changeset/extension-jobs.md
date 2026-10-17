---
"@easytestdata/server": minor
"@easytestdata/qbo-client": minor
"@easytestdata/shared": minor
---

Server extensions can register job kinds (`jobs` on a descriptor) that the shared job runner runs
in the QuickBooks lane; a `needsSandbox` job receives a locked, sandbox-only target object.
`@easytestdata/server/extension` adds `enqueueExtensionJob`, `getExtensionJob` and
`cancelExtensionJob`. `@easytestdata/qbo-client` adds `clearSandbox`. Migration
`002_extension_jobs.sql` adds the `extension` job type.
