# Contributing to D-STATION

Thanks for taking the time to contribute. This document covers everything you need to go from a
fresh clone to a merged pull request.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Windows 10 or Windows 11, x64** | The packaged application contains Windows x64 native binaries. Development on macOS, Linux, or ARM64 is out of scope. |
| **Node.js 22.x** | The shell and plugins target the Node.js 22 line. |
| **pnpm** | Used for the profile workspace in `profiles/web/`. |
| **git** | Any recent version. |

You will also need your own model API key (for example, a DeepSeek API key) to exercise the
application end to end. **Never commit a key.** No keys belong in this repository, in tests, or
in fixture files.

---

## The development loop

```powershell
# One-time: install dependencies and prepare the workspace
./scripts/setup.ps1

# Assemble shell + plugins + the pinned DSH dependency
./scripts/build.ps1

# Launch the built application
./scripts/start.ps1
```

The first `build.ps1` run downloads the Electron and runtime dependencies and is much slower than
later runs. After the first build, a typical loop is: edit source → re-run `build.ps1` → re-run
`start.ps1`.

**A restart is required to verify most changes.** The shell boots the runtime as a child process
and the runtime composes its plugin set at boot. Reloading a window is not enough to pick up a
change to `shell/` or to a plugin's host-side code — quit the application completely and start it
again before you conclude that your change works or does not work.

---

## Source-of-truth rules

These two rules prevent the most common class of bad patch. Read them before editing anything.

### 1. `shell/` is the single source of truth for the wrapper

All Electron shell code lives in `shell/` and only in `shell/`. Builds copy that directory into a
generated application tree; those generated copies are **outputs, not sources**.

- Never edit a file inside a build output directory (`dist/`, `out/`, `build/output/`, `app/`,
  `runtime/`) and expect the change to persist. The next build overwrites it.
- Never "fix" a bug by patching the assembled copy. Fix it in `shell/` and rebuild.
- If you find yourself editing the same code in two places, one of them is generated. Stop and
  find the source.

A pull request whose diff touches only generated files will be closed with a pointer back to this
section.

### 2. `plugins/<name>/` is the single source of truth for each plugin

Each directory directly under `plugins/` is a self-contained, standalone package. The same rule
applies: the directory in this repository is the source, and any copy that appears inside a build
output or inside an installed profile is derived from it.

- Edit a plugin in `plugins/<name>/`, never in an installed copy.
- Keep a plugin's `package.json` consistent with the code it ships.
- If a change requires touching the shell *and* a plugin, keep both changes in the same pull
  request so the pair can be reviewed together.

---

## Before you open a PR

Run through this list. It is short, and every item maps to something reviewers actually check.

- [ ] **Run the syntax check on every file you changed.** For each changed `.js` file:

      ```powershell
      node --check <path\to\changed-file.js>
      ```

- [ ] **Run the tests for the plugin(s) you touched.** A plugin has tests if it contains
      `test/run-tests.mjs`:

      ```powershell
      cd plugins/<name>
      node test/run-tests.mjs
      ```

- [ ] **Run the secret scan script** over the repository and make sure it is clean:

      ```powershell
      ./scripts/secret-scan.ps1
      ```

      If the script is unavailable in your checkout, scan manually for the common shapes
      (`sk-`, `ghp_`, `AKIA`, `-----BEGIN.*PRIVATE KEY-----`) and confirm nothing sensitive
      is staged.

- [ ] **Keep the change focused.** One logical change per pull request. Unrelated formatting
      sweeps, dependency bumps, and refactors belong in separate PRs — they make review harder
      and bisecting a regression much harder.

- [ ] **Update documentation** when behaviour changes: the READMEs, `CHANGELOG.md`, or the
      relevant `SKILL.md` if you touched a skill.

- [ ] **Confirm you committed no personal paths, no machine-specific values, and no secrets.**
      Absolute paths that name your own machine (anything rooted under a user profile
      directory, for example) do not belong in source.

- [ ] **Confirm you did not commit generated or vendored files.** No `node_modules/`, no build
      outputs, no installed copies of plugins, no runtime state.

- [ ] **Verify by restarting**, not by reloading. See the development loop above.

---

## Commit message style

This project uses [Conventional Commits](https://www.conventionalcommits.org/). The prefix is not
decoration — it is what makes the history scannable.

```
<type>: <short imperative summary>

<optional body: what changed and why, not how>
```

Accepted types:

| Type | Use for |
| --- | --- |
| `feat:` | A new user-visible capability. |
| `fix:` | A bug fix. |
| `docs:` | Documentation only. |
| `chore:` | Build scripts, tooling, dependency bumps, housekeeping. |
| `refactor:` | A change that neither fixes a bug nor adds a feature. |
| `test:` | Adding or correcting tests. |

Examples:

```
feat: add wallpaper picker plugin
fix: retry sidecar bind on the next port when 3080 is occupied
docs: document DSTATION_OTA_MANIFEST in both READMEs
chore: pin @deepseek-ai/dsh to 0.1.2-rc.1
refactor: move brand injection out of main.js
test: cover OTA manifest signature rejection
```

Write the summary in the imperative mood (`add`, not `added` or `adds`). Keep the first line under
about 72 characters.

---

## Adding a new plugin

A plugin is a directory directly under `plugins/`. To add one:

1. Create `plugins/<your-plugin-name>/`.
2. Add a `package.json` that declares the plugin's `dsh` entries so the runtime knows how to load
   it. The `dsh` field is the contract between your package and the runtime — declare exactly what
   you ship, and nothing you do not.
3. Add the host-side entry point (typically `index.js`) and, if the plugin has a browser half, a
   client module.
4. If the plugin has tests, add `test/run-tests.mjs` so CI can find and run them. CI runs exactly
   that path for each directory directly under `plugins/`.
5. Document the plugin: add a row to the plugin table in `README.md` and `README.zh-CN.md`, and
   add an entry under `## [Unreleased]` → `### Added` in `CHANGELOG.md`.

### Server-only plugins must not declare `dsh.client`

This is the one rule that will cost you an afternoon if you get it wrong.

If your plugin runs **only** in the host (Node.js) process and ships no browser-side module, it
**must not declare a `dsh.client` entry** in its `package.json`. Declaring a client half that does
not exist means the runtime tries to load a module that is not there — and the failure is not
contained to your plugin. **Composition of the whole runtime fails**, so every plugin appears
broken and the application will not come up.

So: declare `dsh.client` if and only if you actually ship a client module. When in doubt, leave it
out and add it later together with the file.

If you are new to the plugin contract, read the `dsh-plugin-dev` skill in `skills/` first; it
documents the host and browser halves, the client module format, and the failure modes.

---

## Reporting bugs

Open an issue using the **Bug report** form. It asks for the information needed to reproduce the
problem, and filling it in fully is the difference between a fix and a round of questions:

- A short description of the problem.
- Steps to reproduce.
- Expected behaviour versus actual behaviour.
- Your D-STATION version.
- Your Windows version.
- Your Node.js version, when relevant.
- Relevant logs. `launcher.log` lives in the install root.

**Remove any personal API key from pasted logs before submitting.** The issue form includes a
checklist item for this, and it matters: an issue is public and permanent.

For questions, ideas, and anything that is not a reproducible defect, please use GitHub
Discussions instead of the issue tracker.

---

## Licensing of contributions

**No CLA is required.** There is no Contributor License Agreement to sign and no copyright
assignment to make.

Contributions are accepted under the **Apache License, Version 2.0**, the same license that covers
this project. By submitting a pull request you confirm that you have the right to submit the work
and that you agree to it being distributed under Apache-2.0. Inbound contributions are covered by
the license's own terms (section 5, *Submission of Contributions*) — you keep your copyright, and
the project receives the same rights everyone else does.

If your contribution includes third-party code, say so explicitly in the pull request and include
its license and attribution requirements.
