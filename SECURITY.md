# Security Policy

## Reporting a vulnerability

Please don't open a public issue for a security problem.

Report it privately through GitHub: open the [Security tab](https://github.com/o-stahl/osw-studio/security) and choose **Report a vulnerability**. The report stays between you and me until an advisory is published.

Include what you can of:

- the affected version, and whether it is Browser Mode, Server Mode or the desktop app
- steps to reproduce, or a proof of concept
- what an attacker gains

OSW Studio is maintained by one person in spare time, so please allow up to 30 days for a first response. How long a fix takes depends on the problem. Updates go in the report, and you're credited in the advisory unless you'd rather not be.

## Supported versions

Only the latest release receives security fixes.

## Scope

In scope:

- Server Mode: authentication, sessions, workspaces and roles, the admin and sync APIs
- Edge, server and scheduled functions, including the QuickJS sandbox and function `fetch`
- Publishing and hosting: published deployments, review copies, custom domains
- The MCP server and its OAuth grants
- The desktop app's local API and its sites port
- The browser app: storage of provider keys and tokens, the preview, imported projects and templates

Out of scope:

- Vulnerabilities in a model provider's own service
- Problems that need an already-compromised admin account or server
- Content a user publishes on their own site
- Missing hardening headers without a demonstrated impact
- The limits of each hosting set-up listed in [Where Published Sites Are Served](docs/SERVER_MODE.md#where-published-sites-are-served)
