# Desktop installation / Windows + macOS

## Implementation choice

v0.2.1 is **Electron (Chromium + Node.js)** so the existing encrypted SQLite store,
verified webhook ingress, and tested sender code are reused without a risky port.
The resulting packaged desktop app includes its runtime: the end user does **not**
need a separate Node.js installation. This is a real native window rather than just
an open browser tab. No local server port is exposed to the LAN.

Go + Wails, Rust + Tauri, and C++ + Qt are viable long-term alternatives. If bundle
size and idle memory are priorities, migrate the existing backend to Go (Wails)
or Rust (Tauri). Rust/Tauri is a good long-term security-oriented path, but a Rust
rewrite is **not** part of this commit.

## Developer prerequisites

- Windows 10/11 or macOS (Intel/Apple Silicon).
- Node 24 with npm.
- Internet access to npm registry/Electron binary distribution.
- For macOS final distribution: Apple Developer signing and notarization.
- For Windows distribution: Authenticode signing strongly recommended.

```bash
npm install
npm test
npm run desktop
# Production packaging on your target OS:
npm run desktop:win    # on Windows
npm run desktop:mac    # on macOS
```

See `.github/workflows/desktop-build.yml` for the two-OS unsigned artifact build.
Unsigned apps may be blocked by SmartScreen/Gatekeeper; production release requires
publisher signing and on macOS notarization. A Windows build is not a macOS build.

## Data, keys, and OAuth settings

First launch creates per-user `settings.json` containing random `ADMIN_API_KEY`
and `ENCRYPTION_KEY`, and `crosschat.sqlite` in Electron's `userData` directory.
The app auto-authenticates its own dashboard via Electron's isolated preload bridge.
The UI does not save the key in browser local storage. **Back up the encryption key
and database together**; losing the key makes encrypted connection credentials
unrecoverable.

Typical directories:

- Windows: `%APPDATA%/crosschat-hub/` (depends on Electron app name).
- macOS: `~/Library/Application Support/crosschat-hub/`.

OAuth must be configured by the operator in this per-user settings JSON, while the
application is closed, e.g.:

```json
{
  "ADMIN_API_KEY": "<first-launch-generated-key-KEEP-UNCHANGED>",
  "ENCRYPTION_KEY": "<first-launch-generated-key-KEEP-UNCHANGED>",
  "SLACK_CLIENT_ID": "<your-app-client-id>",
  "SLACK_CLIENT_SECRET": "<your-app-client-secret>",
  "SLACK_SIGNING_SECRET": "<your-app-signing-secret>",
  "DISCORD_CLIENT_ID": "<your-discord-application-id>",
  "DISCORD_CLIENT_SECRET": "<your-discord-application-secret>",
  "OAUTH_CALLBACK_BASE_URL": "http://127.0.0.1:8787"
}
```

Keep existing secret values and never commit `settings.json`. In client-owned
native apps, developer credentials inside a locally installed package are not a
strong secret boundary. Each user should configure their **own** application
credentials, or a hosted authorization broker is required for a multi-user product.

OAuth redirect URI **must exactly match** the provider app configuration:

- Slack callback: `<OAUTH_CALLBACK_BASE_URL>/oauth/slack/callback`
- Discord callback: `<OAUTH_CALLBACK_BASE_URL>/oauth/discord/callback`

Provider settings might forbid plain HTTP loopback redirects for a production app.
In that case deploy a securely authenticated HTTPS callback service with a return
channel or run the optional local server behind your own HTTPS public endpoint;
**do not** claim plain localhost callbacks work with every provider.

The desktop app binds only `127.0.0.1:8787`; that port must be available. Bot webhook
receipt from Slack/LINE/Telegram/Discord Interactions needs a **public HTTPS** endpoint
forwarding to the local server, or a separately hosted always-on CrossChat Hub. A
desktop computer powered off cannot receive webhooks. The Discord Gateway is an
outbound WebSocket so it does not require public inbound HTTPS for regular messages.

## Security notes

- No arbitrary login/password scraping; official APIs only.
- The desktop renderer uses sandbox, isolated preload, disabled node integration,
  scoped OAuth external links, and strict CSP.
- OAuth state is single-use and expires in 10 minutes; Discord uses PKCE S256.
- Incoming Discord Gateway messages require configured bot access, explicit Gateway
  enablement, and the privileged Message Content intent to read normal guild text.
- Discord Bot installation is separate from a user's OAuth identity verification.
- `@line:alice` is a routed bot notification, not a native Discord mention.

## GitHub preview releases (v0.2.1+)

The `.github/workflows/desktop-build.yml` workflow now tests and builds on three
independent GitHub-hosted runners: Windows x64, macOS Intel x64, macOS Apple Silicon
arm64. It creates a **prerelease** with MSI/EXE for Windows and separate DMG/ZIP
for each Mac architecture, only after all three installers build successfully.

- Trigger: a push to `main` with a new `package.json` version, or a matching `v*` tag.
- Manual `workflow_dispatch` builds artifacts but does not publish a release.
- An existing release tag is not overwritten. Bump `package.json` before the next release.
- The first preview can be published automatically without manually creating a tag.
- GitHub Actions must have permission to create releases (`contents: write`).
- Builds are **unsigned and unnotarized** until publisher certificates and signing
  secrets are configured. Expect SmartScreen/Gatekeeper prompts; do not bypass OS
  protections on a production device just to install this preview.
- MSI does not support electron-updater based autoupdates. Ship a new MSI per version.
- Build runners must reach npm and Electron's binary downloads. No packages
  are currently cached or bundled into this repository.

To build manually on the appropriate operating system after `npm install`:

```bash
npm run desktop:win:msi    # Windows x64 MSI
npm run desktop:mac:intel  # Intel Mac x64 DMG + ZIP
npm run desktop:mac:arm    # Apple Silicon arm64 DMG + ZIP
```
