# Security Policy

## Supported versions

**Only the latest published release is supported.** D-STATION is a volunteer project; security
fixes are issued against the current release and are delivered through the project's update
mechanism. Older releases are not patched.

If you are running an older build, please update before reporting — the issue may already be
fixed.

---

## Reporting a vulnerability

**Please report vulnerabilities privately. Do not open a public issue.**

A public issue exposes every user of the project to the problem before a fix is available, and it
cannot be un-published once it is indexed.

### How to report

Use GitHub's private vulnerability reporting:

1. Open the repository on GitHub.
2. Go to the **Security** tab.
3. Click **Report a vulnerability**.
4. Fill in the advisory form and submit it.

This creates a private security advisory visible only to you and the maintainers. If you cannot
use that button for any reason, open a *minimal* public issue that says only that you have a
security report and would like a private channel — **do not include the details**.

### What to include

The more of this you can provide, the faster the report can be triaged:

- **A description of the vulnerability** and the impact you believe it has.
- **Affected component**: the shell, a specific plugin, the skills, the OTA update path, or a host
  route.
- **Affected version** of D-STATION, and your Windows version.
- **Reproduction steps**, ideally minimal and deterministic. A proof of concept is welcome.
- **Any relevant logs or configuration**, with credentials removed.
- **Your assessment of severity**, and whether the issue is already public anywhere.
- **How you would like to be credited**, or a request to remain anonymous.

Please **redact API keys, tokens, and personal paths** from anything you paste.

---

## Response expectations

This is a **volunteer project**, and responses are best effort.

- The maintainer aims to **acknowledge a report within 7 days**.
- Acknowledgement is not a fix commitment or a timeline. Triage, a fix, and a release depend on
  severity, complexity, and available time.
- You will be told whether the report is accepted, and you will be credited in the advisory unless
  you ask not to be.

If a week passes with no acknowledgement, a polite follow-up on the same private advisory is
entirely reasonable.

---

## Scope

### In scope

- **The Electron shell** in `shell/`, including its child-process management of the runtime, its
  port selection, and its preload and IPC surfaces.
- **The first-party plugins** in `plugins/`, including any host-side code they expose to the
  renderer or to the network.
- **The OTA verification path**: manifest fetching, Ed25519 signature verification against the
  public key compiled into `shell/ota-core.js`, and the content-addressed update application. A
  weakness that lets an attacker with a hostile manifest or update server get code executed, or
  bypass signature verification, is the highest-severity class of issue in this project.
- **Host routes** served by the shell and by first-party plugins — path traversal, unauthorized
  access to local files, and injected content are all in scope.
- **Handling of user-supplied credentials** by the shell and first-party plugins.

### Out of scope

- **The DSH kernel itself** (`@deepseek-ai/dsh`), including anything inside the upstream runtime.
  D-STATION consumes it as an unmodified npm dependency and cannot fix it. Report those issues
  upstream at
  [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- **Third-party plugins from the market** that are not maintained in this repository. Report them
  to their authors.
- **Anything that requires a malicious local administrator**, or any attack that assumes the
  attacker already has equivalent local privileges. If an attacker can already read and write
  arbitrary files and memory as an administrator on your machine, the application's boundaries are
  not the weak link.
- **Missing hardening that has no demonstrated impact**, such as a report that a header could be
  stricter without an accompanying exploit path.

---

## Please do not

- Do not open a public issue containing vulnerability details.
- Do not test against systems you do not own or have explicit permission to test.
- Do not access, modify, or exfiltrate other people's data while researching.
- Do not run denial-of-service tests against the project's infrastructure or against any update
  server you do not operate.

Thank you for helping keep D-STATION and its users safe.
