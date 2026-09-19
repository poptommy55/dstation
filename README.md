# D-STATION

**English** | [简体中文](README.zh-CN.md)

A Windows desktop application that wraps the open-source **DeepSeek Harness (DSH)** agent
runtime in an Electron shell, with a curated set of first-party plugins, agent skills, and a
self-hosted over-the-air update mechanism.

[![CI](https://github.com/poptommy55/dstation/actions/workflows/ci.yml/badge.svg)](https://github.com/poptommy55/dstation/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey)
![Shell](https://img.shields.io/badge/Electron-44.2.0-47848F)

---

## What it is

D-STATION is a **desktop shell around an existing agent runtime**, not a new agent runtime.

The runtime is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), published on
npm as `@deepseek-ai/dsh` and consumed here as an **unmodified npm dependency**. D-STATION does
not vendor the kernel and does not fork it: the kernel is installed at build time and assembled
into the application alongside the shell and the first-party packages described below.

On top of that kernel, D-STATION adds three things:

1. **An Electron shell** that boots the DSH sidecar as a child process on a local HTTP port,
   injects product branding, and shows a splash screen while the runtime starts.
2. **A curated set of first-party plugins and agent skills** — twelve plugins and five skills
   maintained in this repository.
3. **A self-hosted OTA update client** that verifies a signed manifest and applies
   content-addressed full-file updates.

Every component in this repository is open source. There is no proprietary service behind it,
and no API keys of any kind ship with the source or the releases.

---

## Features

### Desktop shell

- Boots the DSH runtime as a managed child process on a local HTTP port (3080 by default,
  auto-incrementing through 3081–3099 when the port is occupied).
- Brand injection into the runtime's web UI.
- Splash screen covering runtime startup.
- A signed, self-hosted update path (see [OTA updates](#ota-updates)).

### First-party plugins

Twelve plugins ship in `plugins/`, each a standalone npm-style package:

| Plugin | What it does |
| --- | --- |
| `dsh-agent-maker` | A UI workbench for authoring agent presets. |
| `dsh-skill-panel` | Skill management panel. |
| `dsh-knowledge-base` | Knowledge base manager. |
| `dsh-composer-upload` | File upload in the chat composer. |
| `dsh-media-preview` | Renders generated media as preview cards. |
| `dsh-web-search-bing` | Bing-backed web search tool. |
| `dsh-daily-workspace` | Daily scratch workspace. |
| `dsh-ollama` | Local-model provider. |
| `dsh-wallpaper` | Wallpaper picker. |
| `dsh-file-opener` | "Reveal in Explorer" host routes. |
| `dsh-dstation-market` | In-app plugin market browser and installer. |
| `@michengai/dsh-archive-manager` | Sidebar archive and folder management. |

### Agent skills

Five skills ship in `skills/` as Markdown `SKILL.md` documents with optional helper scripts:

| Skill | What it does |
| --- | --- |
| `aces-system` | Image, video, BGM, and digital-human generation through an external ACES gateway, configured with a user-supplied key file. |
| `dsh-green-release` | Packaging a portable release. |
| `dsh-plugin-dev` | Guide for authoring DSH plugins. |
| `dsh-plugin-submit` | Submitting and exporting plugins. |
| `wechat-publisher` | Publishing articles to WeChat Official Accounts. |

### OTA updates

The shell fetches a JSON update manifest, verifies it against an **Ed25519 signature using a
public key compiled into `shell/ota-core.js`**, and applies a content-addressed full-file
update. The signing private key is **not** present in this repository, and no update server is
hardcoded — you point the client at your own server through the `DSTATION_OTA_MANIFEST`
environment variable.

---

## Screenshot

```
<!-- TODO: add screenshot of the main window -->
```

*Placeholder: a screenshot of the D-STATION main window belongs here.*

---

## Requirements

| Requirement | Version / notes |
| --- | --- |
| Operating system | **Windows 10 or Windows 11, x64 only** |
| Node.js | **22.19 or newer** (the DSH kernel's dependency tree requires it) |
| npm | Bundled with Node; used by `scripts/setup.ps1` |
| pnpm | Only needed by the app itself when you install plugins from the marketplace |
| git | Only needed to clone this repository |

### Why Windows x64 only

The distributed build contains **Windows x64 native binaries** — the Electron x64 runtime itself,
plus native Node modules such as `node-pty` and `libsql`. There is no build for macOS, for Linux,
or for ARM64. The shell and the plugins are portable in principle, but the packaged application
is not, and this repository does not ship or test those targets.

---

## Quick start

The intended workflow is three PowerShell scripts. They are the documented entry points for a
local checkout:

```powershell
# 1. Install dependencies and prepare the workspace
./scripts/setup.ps1

# 2. Assemble the application from the shell, the plugins, and the DSH dependency
./scripts/build.ps1

# 3. Launch the built application
./scripts/start.ps1
```

Run them in that order from the repository root. The first build downloads the Electron and
runtime dependencies, so it takes considerably longer than subsequent builds.

> If any of these scripts is missing or fails in your checkout, that is a bug worth reporting —
> they are part of the documented build path, not an optional convenience.

---

## Configuration

### Model API key

**You must supply your own model API key** (for example, a DeepSeek API key). No key ships in
this repository and no key ships in any release. The application asks you for a key on first
run; without one, the runtime starts but cannot reach a model.

Keep your key out of version control. The `.gitignore` in this repository already excludes the
common credential file shapes — see the *Secrets* block near the top of that file.

### Optional environment variables

| Variable | Purpose |
| --- | --- |
| `DSTATION_OTA_MANIFEST` | Absolute URL of your own OTA update manifest. Set this to point the update client at your own server; the default is not a real server address. |

---

## Repository layout

| Path | Contents |
| --- | --- |
| `shell/` | Electron wrapper source — the single source of truth for the shell (`main.js`, `files.js`, `brand-inject.js`, `ota.js`, `ota-core.js`, `ota-preload.js`, `ota-updater.js`, `splash.html`). |
| `plugins/` | Twelve first-party DSH plugins, each a standalone npm-style package. |
| `skills/` | Agent skills — a Markdown `SKILL.md` per skill, plus optional helper scripts. |
| `profiles/web/` | DSH profile configuration: `cordis.yml`, `cordis.patch.yml`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`. |
| `patches/` | Seven `.frag` fragment files consumed by the release tooling. |
| `scripts/` | Build, run, and verification scripts. |

---

## Building a portable release

A portable release is produced from a clean checkout with the build scripts in `scripts/`. The
build assembles the Electron shell, the twelve plugins, the skills, and the pinned DSH kernel
into a self-contained directory tree that runs on a Windows x64 machine without a separate Node.js
installation.

Before distributing a build:

1. Build from a clean checkout, so that no local runtime state is picked up.
2. Confirm the build contains **no API keys and no credentials of any kind**.
3. Confirm the OTA public key compiled into `shell/ota-core.js` is the key you intend to sign
   releases with, and that the corresponding private key is stored outside this repository.
4. Smoke-test the built application by launching it on a machine other than the build machine.

The `dsh-green-release` skill in `skills/` documents the portable-packaging checklist in more
detail, including what must be cleaned out of a build before it is handed to anyone else.

---

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the
development loop, the source-of-truth rules for `shell/` and `plugins/`, the pre-PR checklist,
and commit message conventions.

Please also read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating.

---

## Security

Please **do not** report security vulnerabilities in public issues. Use GitHub's private
vulnerability reporting instead — see [SECURITY.md](SECURITY.md) for the exact steps, what to
include in a report, and what is in and out of scope.

---

## Status

> **D-STATION pins DSH to a release candidate: `0.1.2-rc.1`.**
>
> A release candidate is, by definition, not a stable interface. The DSH kernel may change its
> APIs, its configuration schema, or its plugin contract between now and a stable release, and
> D-STATION will have to follow. **Breaking changes are possible in any release**, including
> changes that require you to reconfigure your profile or update your own plugins.
>
> Treat this project as usable but not yet frozen. Pin a commit if you need reproducibility.

---

## License

D-STATION is released under the **Apache License, Version 2.0**. The full text is in
[LICENSE](LICENSE).

The DSH kernel is MIT licensed and Electron is MIT licensed; both require attribution, which is
why this repository carries a [NOTICE](NOTICE) file. That file records the upstream projects
this application is built on — DeepSeek Harness, Electron, and Chromium — and notes that DSH is
consumed as an unmodified npm dependency.
