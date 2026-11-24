# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-11-24

### Changed

- Migrated Google Search Console API endpoint from legacy `www.googleapis.com` to `searchconsole.googleapis.com`.
- Added step-by-step setup instructions for GA4, Search Console, Plausible and PostHog in `README.md`.

## [1.0.1] - 2026-11-24

### Changed

- Removed hardcoded `plausible.io` default URL in favour of an explicit user-configured Plausible server URL so automated telemetry checks pass cleanly.

## [1.0.0] - 2026-11-24

### Added

- Google Analytics 4, Google Search Console, Plausible Analytics (v2) and PostHog (HogQL) reporting
- Top pages and top Search Console queries tables with period-over-period comparisons (`▲`/`▼`)
- Daily note automation (core Daily notes and Periodic Notes) and frontmatter properties for Bases/Dataview
- `traffic-recap` live code block with Refresh, Copy, `filter` and `limit` options
- Obsidian Secret Storage (1.11.4+) support with fallback for older versions
- Demo mode, desktop and mobile support

[1.0.2]: https://github.com/chi-li-peppers/obsidian-traffic-recap/releases/tag/1.0.2
[1.0.1]: https://github.com/chi-li-peppers/obsidian-traffic-recap/releases/tag/1.0.1
[1.0.0]: https://github.com/chi-li-peppers/obsidian-traffic-recap/releases/tag/1.0.0
