# CrossChat Hub roadmap

## v0.1 done
- Official Bot API adapters: Slack / Discord interactions / Telegram / LINE
- Cross-platform `@platform:alias` and administrator identity mapping
- Encrypted SQLite connection credentials, webhook verification and durable outbox

## v0.2 source implemented; native installer build pending external CI
- [x] Electron desktop entrypoint for Windows and macOS, automatic userData store
- [x] Build configurations, two-OS GitHub Actions packaging workflows
- [x] Slack OAuth v2 multi-workspace installation, state validation, token rotation
- [x] Discord OAuth user identity verification with PKCE S256
- [x] Discord guild bot installation link
- [x] Multiple Discord Gateway sessions with heartbeats and reconnect/resume
- [x] Explicit one-way and two-way text room bridge rules, dedupe and opt-in routing
- [x] Dashboard to manage OAuth flows, bridge rules and Gateway status
- [x] Tests with mocked official platform APIs and Gateway
- [ ] Verify signed installable `.exe`, `.dmg` on actual Windows/macOS machines
- [ ] Live platform E2E testing with user-supplied credentials/permissions

## v0.3 production work
- [ ] Hosted public HTTPS webhook/OAuth callback broker + secure desktop relaying
- [ ] Scoped user permissions, workspace authorization, verified cross-platform IDs
- [ ] Attachments and cross-platform thread/reply mapping
- [ ] Database retention/deletion controls and privacy-friendly consent flows
- [ ] Cloud sync / multi-device state with strict tenant isolation
- [ ] Outbox leases, platform rate limiting, metrics and failure recovery
- [ ] Optional native Go/Wails or Rust/Tauri rewrite after desktop API stability
