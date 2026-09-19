# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because the DSH kernel is currently pinned to a release candidate, minor versions may contain
breaking changes. Those are always called out in the release notes.

## [Unreleased]

### Added

- **Electron shell** (`shell/`) — the Windows x64 desktop wrapper around the DSH runtime:
  - Sidecar boot: the DSH runtime is launched as a child process on a local HTTP port (default
    3080, auto-incrementing through 3081–3099 when the port is occupied).
  - Brand injection into the runtime's web UI.
  - Splash screen covering runtime startup.
- **Twelve first-party plugins** under `plugins/`:
  - `dsh-agent-maker` — UI workbench for authoring agent presets.
  - `dsh-skill-panel` — skill management panel.
  - `dsh-knowledge-base` — knowledge base manager.
  - `dsh-composer-upload` — file upload in the chat composer.
  - `dsh-media-preview` — renders generated media as preview cards.
  - `dsh-web-search-bing` — Bing-backed web search tool.
  - `dsh-daily-workspace` — daily scratch workspace.
  - `dsh-ollama` — local-model provider.
  - `dsh-wallpaper` — wallpaper picker.
  - `dsh-file-opener` — "reveal in Explorer" host routes.
  - `dsh-dstation-market` — in-app plugin market browser and installer.
  - `@michengai/dsh-archive-manager` — sidebar archive and folder management.
- **Five agent skills** under `skills/`:
  - `aces-system` — image, video, BGM, and digital-human generation through an external ACES
    gateway, configured with a user-supplied key file.
  - `dsh-green-release` — packaging a portable release.
  - `dsh-plugin-dev` — guide for authoring DSH plugins.
  - `dsh-plugin-submit` — submitting and exporting plugins.
  - `wechat-publisher` — publishing articles to WeChat Official Accounts.
- **OTA update client** — fetches a JSON manifest, verifies it against an Ed25519 signature using
  a public key compiled into `shell/ota-core.js`, and applies a content-addressed full-file
  update. The signing private key is not part of this repository, and the manifest URL is supplied
  through the `DSTATION_OTA_MANIFEST` environment variable rather than hardcoded.

## [1.0.0] - 2026-09-19

### Added

- Initial public release of D-STATION.
- Electron 44.2.0 shell for Windows 10/11 x64.
- DeepSeek Harness kernel pinned to `0.1.2-rc.1`, consumed as an unmodified npm dependency.
- The twelve first-party plugins listed above.
- The five agent skills listed above.
- Self-hosted OTA update path with Ed25519 manifest signature verification.
- English and Chinese documentation (`README.md`, `README.zh-CN.md`).
- Apache License 2.0, with third-party attribution in `NOTICE`.

[Unreleased]: https://github.com/OWNER/dstation/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/dstation/releases/tag/v1.0.0
