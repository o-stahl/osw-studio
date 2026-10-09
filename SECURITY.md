# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the [Security tab](https://github.com/o-stahl/osw-studio/security) and choose **Report a vulnerability**. Only the maintainer sees the report, and the fix and advisory can be worked on there before anything is public.

Include what you can of:

- the affected version, and whether it is Browser Mode, Server Mode or the desktop app
- steps to reproduce, or a proof of concept
- what an attacker gains

OSW Studio is maintained by one person. Reports are acknowledged within 7 days. Fix times depend on severity; you will be kept up to date in the report, and credited in the advisory unless you would rather not be.

## Supported versions

Only the latest release receives security fixes.

## Scope

In scope:

- Server Mode: authentication, sessions, workspaces and roles, the admin and sync APIs
- Edge, server and scheduled functions, including the QuickJS sandbox and function `fetch`
- Publishing and hosting: published deployments, review copies, custom domains
- The MCP server and its OAuth grants
- The browser app: storage of provider keys and tokens, the preview, imported projects and templates

Out of scope:

- Vulnerabilities in a model provider's own service
- Problems that need an already-compromised admin account or server
- Content a user publishes on their own site
- Missing hardening headers without a demonstrated impact
