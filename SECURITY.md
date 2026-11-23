# Security policy

## Supported versions

Only the latest release receives fixes.

## How Traffic Recap handles your data

- Requests are sent only to `oauth2.googleapis.com`, `analyticsdata.googleapis.com`, `www.googleapis.com` (Search Console), and your configured Plausible / PostHog hosts.
- No telemetry or third-party servers are used.
- On Obsidian 1.11.4+, API keys and refresh tokens can be stored in Obsidian's built-in Secret Storage outside `data.json`.
- Always use read-only scopes (`analytics.readonly`, `webmasters.readonly`, `query:read`).

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/chi-li-peppers/obsidian-traffic-recap/security/advisories/new) instead of opening a public issue.
