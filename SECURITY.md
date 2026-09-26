# Security Policy

## Supported Versions

| Version  | Supported                               |
| -------- | --------------------------------------- |
| Latest   | Yes                                     |
| < Latest | Best-effort patches for critical issues |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through
[GitHub security advisories](https://github.com/easytestdata/easytestdata/security/advisories/new).
If you can't use GitHub, email support@easytestdata.com with "Security" in the subject.

### What to Include

- Description of the vulnerability and its impact
- Steps to reproduce (ideally a minimal reproduction)
- Affected package(s), version or commit, and whether it affects EasyTestData Cloud,
  the local app (`npx easytestdata ui`), or both
- Any suggested fix (optional but appreciated)

Never include real QuickBooks credentials, tokens, or other people's data in a report.

### What to Expect

EasyTestData is maintained by volunteers, so these are goals rather than guarantees:

- Acknowledgment within 3 business days
- An initial assessment within 7 days, with updates as we work on a fix
- A fix or mitigation for critical issues as quickly as possible, followed by a published
  advisory that credits you (unless you prefer otherwise)

## Scope

The following are in scope for security reports:

- `@easytestdata/core` — synthetic data generation engine
- `@easytestdata/qbo-client` — QuickBooks Online API client
- `easytestdata` — CLI tool
- `@easytestdata/shared` — shared validation schemas
- `@easytestdata/server` — backend (EasyTestData Cloud and the local app, `npx easytestdata ui`)
- `@easytestdata/ui` — shared React components
- `@easytestdata/web` — web frontend (Cloud and local)
- `@easytestdata/marketing` — marketing site
- Local mode's protections (loopback only, Host/Origin checks, the `X-EasyTestData` header)

### Areas of Particular Interest

- Authentication and authorization bypasses
- QBO token handling and encryption
- SQL injection
- Cross-site scripting (XSS) in the web frontend
- Rate limiting bypasses
- Information disclosure (user data, tokens, credentials)

## Out of Scope

- QuickBooks Online sandbox environments themselves (report to [Intuit](https://security.intuit.com))
- Third-party dependencies (report upstream, but please let us know so we can update)
- Issues that require physical access to a user's device
- Social engineering attacks against EasyTestData users or staff
- Denial of service attacks (we may still accept reports for application-level DoS)

## Disclosure Policy

We follow **coordinated disclosure**:

1. You report the vulnerability privately through a GitHub security advisory (or by email if you
   can't use GitHub)
2. We acknowledge receipt and begin our assessment in the advisory
3. We work on a fix and coordinate a disclosure timeline
4. Once a fix is released, we publish the advisory and credit you in it (unless you prefer to stay
   anonymous)
5. You are free to publish your own write-up once the advisory is public

We will not take legal action against researchers who follow this responsible disclosure process.

## Recognition

We credit security researchers in the published GitHub security advisory (unless they prefer to
stay anonymous). We do not currently offer a bug bounty program.
