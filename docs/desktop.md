# Desktop workspace (0.4 development)

The desktop entrypoint is `desktop/main.cjs`. It opens the local shell and isolated
Electron WebContentsViews; it does not start the legacy HTTP server or ask users
for Bot Tokens, OAuth secrets, or terminal commands.

## Platforms and authentication

The confirmed targets are Telegram, Discord, Slack, WhatsApp, and LINE. The first
four open official websites in separate persistent profiles. LINE remains blocked:
there is no implemented, authorized embedded personal-chat client. A link to the
external LINE application is not equivalent to meeting the five-tab requirement.

Login, messages and logout are performed by each official site. Website loading
is not proof of successful authentication. Use the site's logout action to revoke
that local login. The toolbar's clear-login control removes the selected
provider's local website data after native confirmation. It closes that provider's
views, authentication popups and unfinished downloads; saved attachments and other
providers are untouched. It does not revoke a server-side device authorization.
External browser authentication does not transfer sessions into this application.

## Navigation and security

Remote contents have sandbox and context isolation enabled, Node disabled, and no
native preload API. Each provider uses its own `persist:crosschat-*` partition.
Permissions are restricted to that provider's official HTTPS origins and media /
notifications require consent. Third-party authentication origins receive no
camera, microphone or notification permissions.

Top-level navigations, server redirects and nested popups share one policy:

- Official provider domains remain embedded.
- Slack additionally permits exact Google, Microsoft and Apple authentication
  hosts listed in `desktop/navigation.cjs`. This is configuration, not verified
  SSO compatibility. Custom enterprise identity providers are not supported yet.
- Other HTTPS destinations require confirmation before opening the system browser.
- Non-HTTPS destinations, credentials in URLs and nonstandard ports are blocked.
- Authentication popups show their current origin in the native title bar.

No page scripts are injected into live messenger websites. Developer smoke tests
inspect the local shell and an explicitly checked loopback fixture only.

## Persistence and local deletion

Window close, the quit button and application quit share one shutdown operation.
Remote views and authentication popups stop before DOM storage and cookie writes
are flushed. A five-second deadline prevents a stuck store holding the executable
open indefinitely; persistence failure/timeout logs a generic error and exits 1,
rather than falsely reporting successful shutdown.

Local deletion blocks new requests, destroys provider writers, cancels its pending
downloads, closes network connections, clears HTTP authentication and Chromium
website data, and flushes the cleared state before reopening. Permission grants
and stale permission-dialog answers are invalidated. A pending-reset marker is
written before deletion and removed only after success; failure/interruption keeps
that provider blocked across restart until an explicit retry succeeds. No cookie
or password is copied/exported and no arbitrary filesystem path can be supplied
through the renderer bridge. Browser-level clearing is not forensic disk erasure.

Site logout, server-side device revocation and real provider authentication remain
separate from this synthetic-fixture storage verification.

## Developer verification

Use Node 24. End users install a packaged application and need no Node runtime.

```sh
npm ci
npm run check
npm test
npm run test:desktop
npm run test:session
npm run desktop:win
```

`test:desktop` uses a fresh temporary profile, creates a real Electron window,
checks keyboard tab synchronization and the LINE limitation panel, then closes
normally. It does not sign in to any provider. It leaves its disposable profile
in the operating system temporary directory, never in the user's normal profile.
`test:session` uses five real Electron process starts and synthetic loopback data
to check persistence, isolation, UI cancellation, failed deletion, blocked state
after restart, retry and durable target-only clearing. Only native confirmation
answers and one intentional API failure are mocked; storage and process restarts
are real. It never signs in to any messenger account.
See [acceptance.md](acceptance.md) for the evidence matrix and remaining gates.

## Installation and release constraints

Windows builds produce NSIS EXE, MSI and ZIP; macOS builds produce separate x64
and arm64 DMG/ZIP. NSIS requests normal window close and waits for the executable
to exit; it blocks installation with an error if a matching process remains.
It does not force-kill processes. This conservative name check may also block if
another Windows user is running the app. Old background-only versions may need
their normal quit action. MSI migration/conflicts and preservation of pending
site data remain unresolved. Do not treat MSI and NSIS as verified interchangeable upgrades.
The normal user flow must never depend on `repair-windows.ps1`.

Only matching version tags publish unsigned prereleases. Branch pushes and manual
builds produce artifacts, not releases. Signing/notarization, real installation
and upgrade tests, and full messaging acceptance remain release blockers. Building
on Windows does not verify macOS. No automatic updater has been implemented.
