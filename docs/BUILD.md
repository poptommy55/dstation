# Building from source

D-STATION builds on Windows only. The build is three commands:

```powershell
pwsh -File scripts/setup.ps1     # fetch Electron, the DSH kernel, a Node runtime
pwsh -File scripts/build.ps1     # assemble dist\
pwsh -File scripts/start.ps1     # run it
```

## Requirements

| Requirement | Why |
| --- | --- |
| Windows 10/11 x64 | The bundle contains Windows x64 native binaries only |
| **Node.js 22.19 or newer** | The DSH kernel's dependency tree requires it; `setup.ps1` enforces this |
| npm (ships with Node) | Fetches Electron and the kernel |
| ~3 GB free disk | ~600 MB of kernel dependencies, ~250 MB Electron, plus the bundle |

There is no pnpm or git requirement for a plain build.

## What `setup.ps1` does

1. Verifies Node is 22.19+.
2. `npm install electron@44.2.0 @deepseek-ai/dsh@0.1.2-rc.1` into `.vendor/`
   (about 600 MB, roughly 25,000 files).
3. **Verifies the Electron platform binary and re-runs Electron's installer if
   it is missing.** This step exists because Electron's postinstall download
   fails silently behind some proxies and registry mirrors: the npm package is
   present, `dist\electron.exe` is not, and the failure only surfaces later as a
   confusing build error. If the download keeps failing, use a mirror:
   ```powershell
   $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
   Remove-Item -Recurse -Force .vendor\node_modules\electron
   pwsh -File scripts/setup.ps1
   ```
4. Downloads the official portable Node 22 x64 runtime into `.vendor/node-runtime/`.

Versions are pinned in `scripts/deps.json`.

## What `build.ps1` does

It assembles `dist/` in the layout the shell requires:

| Step | Result |
| --- | --- |
| 1 | Electron runtime copied to the bundle root; `electron.exe` renamed to `dsh-launcher.exe`; Electron's `default_app.asar` removed |
| 2 | `shell/` copied to `resources/app/`, with a freshly written app manifest |
| 3 | `.vendor/node_modules` copied to `app/node_modules` (the DSH kernel and its dependencies) |
| 4 | Portable Node copied to `runtime/node` |
| 5 | `profiles/web/` copied to `home/profiles/web/`; each plugin in `plugins/` copied to **both** `home/profiles/web/node_modules/` (where DSH loads it from) and `home/plugins/` (so the UI lists it); `skills/` copied to `home/skills/` |
| 6 | `config.json` and `README-FIRST.txt` written |

It then asserts that `dsh-launcher.exe`, `resources/app/main.js`,
`app/node_modules/@deepseek-ai/dsh/lib/bin.js`, `runtime/node/node.exe` and
`home/profiles/web/cordis.yml` all exist, and fails the build if any is missing.

**`runtime/node/node.exe` is not a nicety.** `shell/main.js` decides whether it
is running from a packaged bundle by testing for that exact path. Without it the
shell falls back to development mode and the bundle will not start.

## Running

```powershell
pwsh -File scripts/start.ps1
```

The first launch takes roughly **1–3 minutes**: DSH has to assemble the plugin
tree and build its module fallback links. Subsequent launches take a few seconds.
Watch progress in `dist\launcher.log`.

Closing the window minimises to the tray. To stop the app, right-click the tray
icon and choose Quit — otherwise the single-instance lock will block the next
launch and it will look like nothing happened.

You must supply your own model API key on first run (Settings → Models).

## Verifying a build

```powershell
node scripts/check-secrets.mjs       # credential scan; runs a self-test first
node scripts/verify-tree.mjs         # structure, plugin contract, machine paths
```

Both are what CI runs. `verify-tree.mjs` is worth running before any commit that
touches `plugins/`, because the most common way to break D-STATION is a plugin
that declares `dsh.client` without shipping a client bundle — that stops the
whole runtime from composing, not just that one plugin.

## What this build does and does not produce

**It produces** a working bundle containing the shell, the kernel, this
repository's 12 plugins and 5 skills, and the profile configuration.

**It does not install third-party plugins** from the plugin marketplace. Those
are separate packages with their own licences and are not redistributed here.
Install them from inside the app, or with the DSH CLI:

```powershell
$env:DSH_HOME = "<bundle>\home"
<bundle>\runtime\node\node.exe <bundle>\app\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile web add <package>
```

**It does not produce a distributable installer.** The output is a portable
directory: zip it and the recipient unzips and runs `dsh-launcher.exe`. Nothing
writes to the registry.

**The kernel is pinned to a release candidate** (`0.1.2-rc.1`). Upstream may
change plugin-facing APIs between rc builds. Bumping `scripts/deps.json` is a
deliberate act: re-run the plugin test suites afterwards.

## Platform limitations

The build is Windows x64 only, and cannot be ported by changing a flag:

- `dsh-launcher.exe` is a Windows x64 Electron binary.
- The kernel's dependency tree includes Windows x64 native modules.
- The portable runtime downloaded by `setup.ps1` is the `win-x64` Node build.

macOS, Linux and ARM64 would each need a separate build pipeline.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `setup.ps1` says Node is too old | The kernel needs 22.19+; upgrade Node |
| `electron.exe` missing after setup | Proxy or mirror blocked the download; set `ELECTRON_MIRROR` as above |
| `build.ps1` says prerequisites missing | `setup.ps1` did not finish; re-run it |
| App exits immediately, log says the bundle is incomplete | `runtime/node/node.exe` or `app/node_modules` is missing; re-run `build.ps1` |
| Window never appears on second launch | An instance is already in the tray. Quit it from the tray first |
| First launch seems hung | It is assembling the plugin tree; give it up to 3 minutes and watch `dist\launcher.log` |
