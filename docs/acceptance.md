# Development acceptance evidence

Date: 2026-10-23 (Asia/Taipei). Base: `feature/messenger-tabs-experimental`
at `70c10d7`. Confirmed target services: Telegram, Discord, Slack, WhatsApp, LINE.
This is a development checkpoint, not approval for a production release.

## Automated evidence from this workspace

| Check | Result | What it establishes |
|---|---|---|
| `npm run check` | Pass | JavaScript syntax, including navigation policy and smoke harness |
| `npm test` | 43 passed | Backend mock/local checks; navigation, bounded shutdown, target-scoped clearing and persistent reset intent ordering |
| `npm run test:desktop` | Pass on Windows 11 / Node 24.0.2 / Electron 45 | Real visible window, Ctrl+5 / Ctrl+1 shell selection, honest LINE panel, remote view Node disabled, normal window close with process exit code 0 |
| Windows x64 build | MSI / NSIS EXE / ZIP produced | Build only; unsigned. Unpacked packaged EXE created a visible native window and exited normally with code 0 |
| `npm run test:session` | Pass on local Windows 11 | Five real process starts: synthetic Cookie/localStorage/IndexedDB persistence, platform isolation, cancellation, popup teardown, injected reset failure, restart-persistent block, retry, deletion persistence and other-provider preservation |
| Previous remote syntax/unit CI | Pass, code commit `7492fe8` | [Run 39949726550](https://github.com/JackChen6203/CrossChat-Hub/actions/runs/39949726550); new lifecycle/reset changes awaiting remote verification |
| Previous remote desktop matrix | All jobs passed, code commit `7492fe8` | [Run 39949726403](https://github.com/JackChen6203/CrossChat-Hub/actions/runs/39949726403): native window smoke on Windows/macOS x64/arm64, three packaging artifacts; release skipped |
| Remote Windows NSIS lifecycle | Pass on hosted Windows runner | Clean install, visible window, normal exit, reinstall same version while running, relaunch, uninstall while running, executable/process removal |
| Remote macOS x64/arm64 | Build, source-window smoke and DMG mount checks passed | Not proof of packaged installation/upgrade or real provider login |

The native-window harness uses a newly created OS temporary profile and does not
touch existing messenger sessions. It inspects the local shell only. No account
login, live messages or website JavaScript injection is part of this smoke test.
The session harness also inspects an explicitly checked loopback fixture containing
synthetic data only. It mocks native confirmation answers and one intentional
Chromium deletion failure; actual storage APIs, real auth-popup creation/teardown
and all five process starts are exercised. The failed-state shell was visually
inspected at minimum window width. No real QR code or account data was captured.

Local Windows build initially failed because winCodeSign's bundled macOS dylib
symlinks could not be extracted without Windows symlink privileges. The successful
retry used a workspace-local ignored `build/bin/cache` containing the downloaded
Windows tools with the irrelevant `darwin` subtree excluded. No system privilege
change and no signing bypass were applied; Authenticode status remains NotSigned.
The build was invoked directly through `electron-builder.cmd --win --x64 --publish
never` because this host's npm/PowerShell argument forwarding dropped flags.

The first packaged-window probe used hidden-window startup and could not find a
visible MainWindowHandle. A normal interactive launch then passed window creation
and `CloseMainWindow` exit checks using a separate temporary user-data directory.
Neither probe installs or upgrades the application. MSI/NSIS installation,
upgrade/uninstall, and macOS builds have not been executed in this workspace.

An initial Linux Xvfb CI smoke failed before application startup because the
runner's Chromium SUID helper was not configured. Native-window smoke now runs
on the actual supported Windows/macOS packaging targets instead; no `--no-sandbox`
flag or runner privilege modification was introduced. Linux syntax/unit checks
remain in the separate CI workflow.

## Platform matrix

| Platform | Source implementation | Mock/local tests | Packaging | Real login | Real send/receive | Login retained after restart |
|---|---|---|---|---|---|---|
| Telegram | Official web view; separate legacy MTProto backend | Yes; MTProto is mocked | Included in desktop; see build evidence | Unverified | Unverified | Unverified |
| Discord | Official web view | Origin policy / legacy mocked OAuth and bot API | Included in desktop; see build evidence | Unverified | Unverified | Unverified |
| Slack | Official web view; selected SSO origin policy | Navigation / legacy mocked OAuth and bot API | Included in desktop; see build evidence | Unverified, including SSO | Unverified | Unverified |
| WhatsApp | Official web view | Isolation / origin policy | Included in desktop; see build evidence | Unverified QR/device linking | Unverified | Unverified |
| LINE | Unsupported panel, not an embedded chat client | Limitation panel checked | Panel included only | Not implemented in tab | Not implemented in tab | Not applicable |

## Required manual acceptance (each supported OS/architecture)

Record only date, OS, app version/commit and pass/fail; never include OTPs, QR
images, passwords, session files, real message text or tokens in evidence.

- Clean installation, launch, native window close, process exit and relaunch.
- Upgrade from previous NSIS and MSI builds separately, preserving session data.
- Document MSI/NSIS conflict behavior; uninstall and verify no orphaned process.
- Four web services: real login (including QR/2FA and Slack SSO), room list,
  send/receive using consenting test accounts, attachment save and permissions.
- Restart the app and confirm the same account remains authenticated.
- Use the site's logout, restart, and verify that account is no longer signed in.
- From a message, open an external link: cancel does not navigate; confirm opens
  system browser; official content remains in the correct platform partition.
- Verify authentication popup origin title, allowed SSO redirects, denied unsafe
  schemes and custom-IdP limitation; ensure no credential/session leakage.
- Windows installation/upgrade/uninstall and macOS x64/arm64 installation,
  launch/close/relaunch/update must have separate evidence.

## Installer regression and verified fix

Remote run `39948891586` passed all three native-window smokes and both macOS
packaging/mount jobs, but Windows NSIS installation returned `0xC0000005` before
launch. The subsequent fix replaces both the old unconditional force-kill hook
and the default nsExec/getProcessInfo process-check path with a native WM_CLOSE
request plus ExecWait-based system task listing. Any remaining process or failed
check blocks modification with exit code 2; no force termination occurs.
The NSIS installer compiles locally. The new CI lifecycle script requires a clean
runner and checks install, normal close, same-version reinstall while running,
relaunch, and uninstall while running. All checks passed in run `39949726403` at
code commit `7492fe8`, including exit code 0 when the installer/uninstaller closed
the application. The installed executable and processes were removed afterward.
Windows x64, macOS x64 and macOS arm64 artifacts were confirmed present on that run.
Same-version reinstall must not be described as an upgrade from v0.3.1.

## Remaining product blockers (release gates)

LINE has no authorized embedded personal-chat solution in this implementation.
The official Messaging API is for bots/Official Accounts, not a replacement for
personal desktop chats: https://developers.line.biz/en/docs/messaging-api/overview/
Electron supports only a subset of extension APIs and arbitrary Chrome Web Store
extensions are unsupported: https://www.electronjs.org/docs/latest/api/extensions/
These establish why the existing API/extension routes cannot be claimed as a
completed solution; commercial authorization and a viable implementation remain
unresolved rather than a legal conclusion about all possible future integrations.

Cross-platform `@platform:alias` in website tabs has no live authorized delivery,
consent/revocation or real platform-pair E2E evidence. Other gates include live
provider validation of the new storage lifecycle, installer migration,
signing/notarization and custom enterprise SSO. Local persistence/clearing fixture
evidence does not establish real provider logout, device revocation or server
message retention. No formal Latest Release may be inferred from this work.

## Latest storage lifecycle checkpoint

Code commit `7c2ba1b`: 44 local unit/mock tests pass. The five-process synthetic
session persistence/reset test passes locally after isolating test configuration
to the loopback fixture before the desktop entrypoint loads. An unwritable reset
intent now stops current profile writers without starting deletion; it cannot
promise restart blocking when the disk itself refuses the marker write.

Both installed macOS bundle launch/normal quit/relaunch checks passed at commit
`ca6887a` in run 39952161980, but that matrix failed on Windows storage-fixture
navigation competition. The fixture correction is commit `c284b17`; latest code
verification is still running at:
https://github.com/JackChen6203/CrossChat-Hub/actions/runs/39959022902
Do not treat an earlier green packaging run as proof for the current code.
