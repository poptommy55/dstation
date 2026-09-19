# Architecture

This document describes how D-STATION is put together and why the repository is
laid out the way it is. It is aimed at someone who wants to change the code, not
at someone who just wants to run it — see the [README](../README.md) for that.

## What D-STATION is, precisely

D-STATION is **not** a fork of the agent runtime. It is a desktop wrapper plus a
set of first-party extensions around an unmodified third-party kernel:

| Layer | What it is | Where it comes from |
| --- | --- | --- |
| Kernel | DeepSeek Harness (`@deepseek-ai/dsh`), MIT | npm dependency, pinned in `scripts/deps.json` |
| Shell | Electron 44 desktop wrapper | `shell/`, this repository |
| Extensions | 12 plugins + 5 agent skills | `plugins/`, `skills/`, this repository |
| Runtime | Portable Node 22 | downloaded by `scripts/setup.ps1`, not vendored |

Nothing in this repository is a copy of the kernel. That is deliberate: it keeps
the MIT attribution story simple and it means kernel updates are a version bump,
not a merge.

## The process model

```
dsh-launcher.exe            (Electron main process, shell/main.js)
   |
   |  spawns as a child process, on 127.0.0.1:<port>
   v
runtime/node/node.exe
   app/node_modules/@deepseek-ai/dsh/lib/bin.js   web --port <port>
   |  DSH_HOME = <bundle>/home
   v
DSH web server  -->  loaded into an Electron BrowserWindow (not an external browser)
```

Key details:

- **Port selection.** The shell tries 3080 first and walks up to 3099 until it
  finds a free port, so several copies of the app can run side by side from
  different directories.
- **The sidecar is the real product.** The Electron layer is a window, a tray
  icon, a splash screen and a few IPC bridges. Everything the user sees is the
  DSH web UI.
- **`runtime/node` is not optional.** `shell/main.js` decides whether it is
  running from a packaged bundle by testing for `<exeDir>/runtime/node/node.exe`.
  If that file is absent the shell falls back to development mode and the bundle
  will not start. This is why `scripts/build.ps1` refuses to produce a bundle
  without it.
- **Restart semantics.** Closing the window minimises to the tray; the sidecar
  keeps running. Only "Quit" from the tray stops it. The shell also watches the
  sidecar and restarts it up to 5 times if it exits unexpectedly.

## Data layout

Everything the app owns lives under the bundle root, so the whole thing is
portable: copy the directory and you have a second independent install.

```
<bundle>/
  home/
    profiles/web/     DSH profile: cordis.yml, cordis.patch.yml, package.json
    plugins/          installed plugins
    skills/           agent skills (SKILL.md plus any helper scripts)
    sessions/         user data: conversations          (created at runtime)
    storages/         user data: workspaces             (created at runtime)
    settings.yaml     user settings, including API keys  (created at runtime)
```

`home/settings.yaml` and `home/.credentials.yaml` hold the user's own API keys
and are created on first run. Neither is in this repository, and neither should
ever be committed. `.gitignore` covers both.

## The plugin contract

A plugin is an ordinary npm-style package directory with a `package.json` that
carries a `dsh` block.

- **A server-side plugin** exports an `apply()` from its entry point and must
  **not** declare `dsh.client`. Declaring `dsh.client` without shipping a client
  bundle makes the entire runtime fail to compose — not just that plugin. This is
  the single most common way to brick a D-STATION install. `scripts/verify-tree.mjs`
  checks for it.
- **A plugin with a UI** additionally declares `dsh.client` and ships a
  `./client` export, which DSH loads into the browser side of the app.
- **Host routes** are registered on the DSH web server and are therefore reachable
  from the page. Anything that touches the filesystem or spawns a process must
  validate its inputs; see `plugins/dsh-file-opener/path-guard.js` for the pattern.

Plugins live in `plugins/` in this repository. At build time they are copied into
both `home/profiles/web/node_modules/` (where DSH loads them from) and
`home/plugins/` (so they appear as installed plugins in the UI).

## The shell's IPC bridge

The shell exposes a small, deliberately narrow surface to the page, using
`contextBridge` via `shell/ota-preload.js`:

```
client code (in a plugin's client.js)
  -> window.__DSTATION_OTA__ / __DSTATION_SKILLS__ / __DSTATION_FILES__
  -> ipcRenderer.invoke(...)
  -> ipcMain.handle(...) registered in shell/main.js
  -> shell/files.js, shell/ota.js, ...
```

All four layers have to agree on the channel name. Adding a bridge means touching
the preload script, the main-process handler, and the caller.

## Updates (OTA)

The update path is **content-addressed and signature-verified**, and it is
entirely client-side in this repository:

1. `shell/ota.js` fetches a JSON manifest from the URL in the `DSTATION_OTA_MANIFEST`
   environment variable. **This repository ships no default update server.**
2. `shell/ota-core.js` verifies the manifest against an **Ed25519 public key
   compiled into the client**. The corresponding private key is not in this
   repository and never should be.
3. If the signature verifies, changed files are fetched by content hash and
   written only inside an allow-listed set of paths.

Two consequences worth understanding:

- **Failing closed is intentional.** A missing signature, a bad signature, or a
  verification exception all cause the manifest to be rejected. There is no
  "skip verification" flag.
- **Anyone can run their own update server.** That is the point of the manifest
  being configurable. If you want to distribute your own builds, generate your
  own Ed25519 keypair, embed the public key in `shell/ota-core.js`, and sign your
  own manifests.

## Repository layout

| Path | Contents |
| --- | --- |
| `shell/` | Electron wrapper. Single source of truth; the build copies it into `resources/app/`. |
| `plugins/` | 12 first-party plugins. Single source of truth; the build copies them into the profile. |
| `skills/` | 5 agent skills. Copied into `home/skills/` at build time. |
| `profiles/web/` | DSH profile configuration, including `cordis.patch.yml` which adjusts the kernel's own config. |
| `patches/` | Fragment files consumed by the release tooling. |
| `scripts/` | Setup, build, start, and verification. |
| `.github/` | CI and contribution templates. |

## Why `shell/` and `plugins/` are single sources of truth

An earlier iteration of this project kept a second copy of the shell under the
installed `resources/app/` and edited that instead. The copies drifted: the
"source" directory silently became stale code, and anyone who trusted it would
have reverted real fixes.

The rule now is: **edit `shell/`; never edit a built copy.** The same applies to
plugins. Built output under `dist/` is disposable and is gitignored.
