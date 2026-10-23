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


## v0.3: User-first sign-in and platform limitations

When the desktop app starts, the primary screen shows **Telegram, Slack, Discord and LINE
account cards**. Developer-only Bot Token/Webhook forms and manual alias mapping are
behind an expandable Advanced Integration section. After OAuth identity verification,
accounts appear in the account list. This is not proof that third-party chat content
is accessible.

- **Slack:** the sign-in button requests a *user* OAuth token with `user_scope`.
  Given approved scopes and workspace access, the Slack panel lists channels,
  loads 50 messages and can send text messages. Errors from Slack permission policy
  are surfaced; no history or messages are simulated. Slack user tokens are encrypted
  using the existing AES-GCM encrypted SQLite credentials store.
- **Discord:** `identify` provides verified username and ID only; account tokens are
  discarded. No user-message automation, no self-bot or cookie scraping.
- **LINE:** LINE Login obtains the profile via the provider's HTTPS endpoint and
  discards the access token after verification. No personal chat API is available;
  signing in will **not** import personal LINE messages or send on the user's behalf.
- **Telegram:** personal login has **not yet been implemented**. Future supported
  client work requires official MTProto/TDLib authentication, encrypted local
  sessions, 2FA and account logout. The existing Bot API is not a substitute.

Developer configuration example in the desktop profile `settings.json`:

```json
{
  "SLACK_CLIENT_ID": "your-client-id",
  "SLACK_CLIENT_SECRET": "your-client-secret",
  "DISCORD_CLIENT_ID": "your-discord-application-id",
  "DISCORD_CLIENT_SECRET": "your-discord-client-secret",
  "LINE_CLIENT_ID": "your-LINE-Login-channel-ID",
  "LINE_CLIENT_SECRET": "your-LINE-Login-channel-secret",
  "OAUTH_CALLBACK_BASE_URL": "https://your-registered-callback-origin.example"
}
```

**Merge these keys into the existing settings file; do not delete/recreate
`ADMIN_API_KEY` or `ENCRYPTION_KEY`, which protect the stored data.**
The HTTPS callback above must be actually routed back to the **same local
running application** holding the OAuth state, or handled by a purpose-built
secure hosted OAuth broker; simply placing an arbitrary URL there will not work.
Register `/oauth/line/callback`, `/oauth/discord/callback`, and `/oauth/slack/callback`
with the exact matching provider application.

Do not ask users for their LINE, Discord, Telegram or Slack passwords within
CrossChat Hub. Use official authorization screens.

## v0.3.1: Desktop close / installer file locked on Windows

Old builds could block during `app.before-quit` awaiting `http.Server.close` with no deadline. The new desktop client has an explicit "結束程式" button and waits up to 2.5 seconds for HTTP/Discord resources, then calls Electron `app.exit(0)`. The runtime also forces idle HTTP connections closed after a short grace period. This prevents the new version retaining the executable after close, but cannot retroactively kill a stale v0.3.0 process.

Before installing over v0.3.0, quit the app. If `CrossChat Hub.exe` remains active, from the cloned repo run `scripts/repair-windows.ps1` to stop only the process installed in your **own** `%LOCALAPPDATA%\Programs\CrossChat Hub` directory. This script preserves encrypted data files and does not require admin by default. Do not mix MSI and NSIS EXE as interchangeable in-place upgraders: uninstall the older distribution first if needed. The MSI remains per-user (`perMachine:false`). Unsigned preview installers may still trigger Windows Defender SmartScreen or enterprise restrictions.

## v0.3.1: Telegram user MTProto and local demo

The desktop always offers local demonstration mode. It is completely offline, with three seeded mock rooms and an example `@line:alice` simulated delivery. It does not connect to LINE/Telegram/Slack.

For a **real** Telegram personal account the app maintainer must register an API app at https://my.telegram.org and set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in the desktop `settings.json` (Electron `userData` directory, typically `%APPDATA%\crosschat-hub` on Windows) **before restarting CrossChat Hub**. This is app setup, not a user Bot Token. Then the first-party UI asks only for a phone number, app/SMS code, and the Telegram two-step password if enabled. The client uses teleproto MTProto; authenticated session is stored encrypted by the existing local store. The client is not secretly using a self-bot on Discord or the LINE personal protocol.

The integration tests use a mocked Telegram transport and cannot confirm delivery of a real verification code or network interoperability. Provider-requested email and reCAPTCHA flows are not implemented, so some Telegram users may still be blocked.
