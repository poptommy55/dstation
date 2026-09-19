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

## [1.0.1] - 2026-09-19

The first CI run on the public repository failed. Everything below is a real defect
it surfaced, not a test-workaround.

### Fixed

- **`setup.ps1` broke on its very first command.** It invoked npm through the call
  operator; on Windows `npm` resolves to `npm.ps1`, whose argument rewriting removes
  `$MyInvocation.InvocationName.Length` characters from the front of the parsed
  command text. The call operator's leading `& ` shifts that offset by two, so npm
  received `pm install` and died with `Unknown command: "pm"`. Now uses `npm.cmd`,
  falling back to `npm-cli.js`.
- **The profile could not boot.** It listed eight third-party marketplace packages as
  profile bundles. None are redistributed here, so the kernel aborted with
  `cannot resolve profile bundle`. Only the kernel's own bundles and this repository's
  plugins remain.
- **The sandbox root was hardcoded.** `profiles/web/cordis.patch.yml` pinned
  `workspaceRoot` to one machine's deployment path; plugin file writes were denied
  anywhere else. It now follows `DSH_HOME`.
- **`dsh-agent-maker` validated the wrong thing first.** `buildAgentBundle` checked
  that the presets directory existed before checking the shape of the requested ids.
  On any machine with no user agents yet — including every fresh install — a
  path-traversal id returned 500 rather than 400, and the test that guards that
  boundary could never reach it. Id shape is now validated before the filesystem is
  touched.
- **`dsh-media-preview` tests compared paths as strings.** Windows gives one directory
  several equivalent spellings; the runner's `TEMP` is an 8.3 short name
  (`C:\Users\<user>\...`) while the plugin emits the long form. Note that
  `fs.realpathSync` does *not* expand short names — `fs.realpathSync.native` does.
  Comparisons are now by filesystem identity (`st_dev`/`st_ino`) where it matters.
- **The CI secret scanner flagged its own source.** `scripts/check-secrets.mjs`
  contains the credential patterns by definition.
- `actions/checkout` and `actions/setup-node` moved from v4 to v7; v4 targets the
  deprecated Node 20 runner.

### Added

- `scripts/smoke-test.mjs` — boots the built bundle on a scratch port and proves it
  serves the web UI. Static checks passed on a bundle that could not start; only
  booting it found the profile-bundle failure.

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

[Unreleased]: https://github.com/poptommy55/dstation/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/poptommy55/dstation/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/poptommy55/dstation/releases/tag/v1.0.0
