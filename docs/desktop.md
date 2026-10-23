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
that local login; there is currently no CrossChat clear-profile control. External
browser authentication does not transfer sessions into this application.

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
inspect only the local shell. Site logout, secure session flushing on shutdown,
data deletion and provider-specific authentication still need further validation.

## Developer verification

Use Node 24. End users install a packaged application and need no Node runtime.

```sh
npm ci
npm run check
npm test
npm run test:desktop
npm run desktop:win
```

`test:desktop` uses a fresh temporary profile, creates a real Electron window,
checks keyboard tab synchronization and the LINE limitation panel, then closes
normally. It does not sign in to any provider. It leaves its disposable profile
in the operating system temporary directory, never in the user's normal profile.
See [acceptance.md](acceptance.md) for the evidence matrix and remaining gates.

## Installation and release constraints

Windows builds produce NSIS EXE, MSI and ZIP; macOS builds produce separate x64
and arm64 DMG/ZIP. The NSIS hook currently force-terminates an existing executable;
graceful update, MSI migration/conflicts and preservation of pending site data
remain unresolved. Do not treat MSI and NSIS as verified interchangeable upgrades.
The normal user flow must never depend on `repair-windows.ps1`.

Only matching version tags publish unsigned prereleases. Branch pushes and manual
builds produce artifacts, not releases. Signing/notarization, real installation
and upgrade tests, and full messaging acceptance remain release blockers. Building
on Windows does not verify macOS. No automatic updater has been implemented.
