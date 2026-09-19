<!--
Thanks for contributing to D-STATION. Please fill in every section below.
See CONTRIBUTING.md for the development loop and the source-of-truth rules.
-->

## What this changes

<!-- A short summary of the change. If it touches the shell or a plugin, name them. -->

## Why

<!-- The problem this solves, or the issue it closes (e.g. "Closes #123"). -->

## How it was tested

<!--
Be specific: paste the exact commands you ran, not a description of them. Reviewers use
this to reproduce your verification.

Important: changes to the shell or to the plugin tree require a real restart to verify.
The runtime composes its plugin set at boot and the shell is a separate process, so
reloading the window is not sufficient. If your change is in shell/ or plugins/, please
confirm you fully quit and relaunched the application.
-->

```powershell
# commands you ran
```

**Did the change require a restart to verify?** <!-- yes / no -->

## Checklist

- [ ] This pull request makes a single, focused change.
- [ ] I ran the syntax check (`node --check`) on every JavaScript file I changed.
- [ ] I ran the tests for the plugin(s) I touched (`node test/run-tests.mjs`), or explained why there are none.
- [ ] I ran the secret scan and it is clean.
- [ ] I updated the documentation if behaviour changed (README, CHANGELOG, or a SKILL.md).
- [ ] I committed no personal paths and no secrets.
- [ ] I committed no generated or vendored files (no `node_modules/`, no build outputs, no installed plugin copies).
- [ ] I edited `shell/` and `plugins/` as the single source of truth, not a generated copy.
