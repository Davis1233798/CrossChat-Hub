# Development acceptance evidence

Date: 2026-10-23 (Asia/Taipei). Base: `feature/messenger-tabs-experimental`
at `70c10d7`. Confirmed target services: Telegram, Discord, Slack, WhatsApp, LINE.
This is a development checkpoint, not approval for a production release.

## Automated evidence from this workspace

| Check | Result | What it establishes |
|---|---|---|
| `npm run check` | Pass | JavaScript syntax, including navigation policy and smoke harness |
| `npm test` | 35 passed | Backend mock/local checks; navigation policy, redirects and nested popup behavior with fake WebContents |
| `npm run test:desktop` | Pass on Windows 11 / Node 24.0.2 / Electron 45 | Real visible window, Ctrl+5 / Ctrl+1 shell selection, honest LINE panel, remote view Node disabled, normal window close with process exit code 0 |
| Windows x64 build | MSI / NSIS EXE / ZIP produced | Build only; unsigned. Unpacked packaged EXE created a visible native window and exited normally with code 0 |
| CI changes | Not yet run remotely | Node 24, lockfile install, Linux Xvfb native-window smoke; packaging includes `codex/**` branches |

The native-window harness uses a newly created OS temporary profile and does not
touch existing messenger sessions. It inspects the local shell only. No account
login, live messages or website JavaScript injection is part of this smoke test.

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

## Remaining product blockers

LINE has no authorized embedded personal-chat solution in this implementation.
The official Messaging API is for bots/Official Accounts, not a replacement for
personal desktop chats: https://developers.line.biz/en/docs/messaging-api/overview/
Electron supports only a subset of extension APIs and arbitrary Chrome Web Store
extensions are unsupported: https://www.electronjs.org/docs/latest/api/extensions/
These establish why the existing API/extension routes cannot be claimed as a
completed solution; commercial authorization and a viable implementation remain
unresolved rather than a legal conclusion about all possible future integrations.

Cross-platform `@platform:alias` in website tabs has no live authorized delivery,
consent/revocation or real platform-pair E2E evidence. Other gates include graceful
session flushing, local data clearing, installer migration, signing/notarization
and custom enterprise SSO. No formal Latest Release may be inferred from this work.
