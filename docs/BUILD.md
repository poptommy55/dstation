# Building from source

D-STATION builds on Windows only. The build is three commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1     # fetch Electron, the DSH kernel, a Node runtime
powershell -ExecutionPolicy Bypass -File scripts/build.ps1     # assemble dist\
powershell -ExecutionPolicy Bypass -File scripts/start.ps1     # run it
```

## Shell

The scripts target **Windows PowerShell 5.1 or newer**, so the built-in
`powershell` works and PowerShell 7 (`pwsh`) is not required. The examples below
use `powershell -ExecutionPolicy Bypass -File`; `-ExecutionPolicy Bypass` matters
because the default Windows execution policy blocks unsigned `.ps1` files.

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
   powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
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
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
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

Then prove the bundle actually runs:

```powershell
node scripts/smoke-test.mjs
```

This boots the bundled sidecar on a scratch port (never 3080, so it will not
disturb a running instance), waits for its tokenised URL, follows the
authentication redirect, and checks that the web UI comes back as HTML.

A structurally complete bundle is **not** evidence that the app works — it can
be missing a plugin the profile references and still pass every static check.
That is exactly what happened the first time this repository was built from
scratch, and the failure only appeared at boot:

```
cannot resolve profile bundle "dshmarket" from the dsh installation or <profile>
```

Two details worth knowing if you write your own probe:

- A bare `GET /` returns **401**. That means the server is up and wants a token,
  not that it failed to start. Request the tokenised URL instead.
- That URL answers **303** and sets a cookie; the page itself is served against
  the cookie. `fetch()` does not keep a cookie jar across redirects, so the
  redirect has to be followed by hand.

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
| `Unknown command: "pm"` from npm | You called `& npm` from a script. On Windows `npm` resolves to `npm.ps1`, which rebuilds its argument list by stripping `$MyInvocation.InvocationName.Length` characters off the parsed command text; the call operator's leading `& ` shifts that offset by two and eats the start of the subcommand. Use `npm.cmd`, which `setup.ps1` already prefers |
| `build.ps1` says prerequisites missing | `setup.ps1` did not finish; re-run it |
| App exits immediately, log says the bundle is incomplete | `runtime/node/node.exe` or `app/node_modules` is missing; re-run `build.ps1` |
| `cannot resolve profile bundle "<pkg>"` at boot | `profiles/web/package.json` lists a bundle that is not installed. Either install that package (`dsh plugin --profile web add <pkg>`) or remove it from `dependencies` and `dsh.profile.bundles` |
| Window never appears on second launch | An instance is already in the tray. Quit it from the tray first |
| First launch seems hung | It is assembling the plugin tree; give it up to 3 minutes and watch `dist\launcher.log` |

## Verification performed when this repository was published

Recorded so a future maintainer knows what was actually checked, as opposed to
what merely looked fine:

| Step | Result |
| --- | --- |
| `setup.ps1` into an empty vendor directory | 535 packages in 39 s; Electron's postinstall did not fetch the binary, the explicit repair step did |
| `build.ps1` from that vendor | 1070 MB, 28,051 files, 12 plugins, 5 skills |
| `smoke-test.mjs` | sidecar served the UI: 3.1 s, HTTP 200, ~26 KB of HTML |
| `dsh-launcher.exe` launched by hand | service ready in 2 s, window shown at 5 s, brand injection applied |
| Plugin test suites (all six) | 126 / 177 / 132 / 37 / 69 assertions, all passing |

Not verified: a build on a machine that has never had D-STATION installed, and
the ACES skill end to end (that needs a real ACES key).
