# CrossChat Hub development priorities

## Current source implementation

- Four official website views with isolated persistent profiles and five tabs.
- Explicit LINE unsupported panel; WhatsApp confirmed as fifth target (2026-10-23).
- Navigation/redirect/nested-popup controls and origin-scoped permission prompts.
- Keyboard tab synchronization and isolated-profile native Electron smoke test.
- Legacy optional Bot/OAuth/MTProto backend with mocked API tests.

## P0: release blockers

- Authorized, maintainable LINE personal-chat embedding solution or approved scope change.
- Real login, message send/receive, attachments, logout and restart retention on
  Telegram, Discord, Slack (including SSO) and WhatsApp on all supported OS targets.
- Graceful update/shutdown with persistent-session flushing, Windows clean install,
  upgrade from previous versions, uninstall, and MSI/NSIS coexistence policy.
- Actual macOS Intel/ARM launch/close/update checks, signing and notarization.
- User-facing per-platform local data deletion with safe popup/session teardown.

## P1: authorized cross-platform notifications

- Self-service consent, identity binding, destination confirmation and revocation.
- Official API delivery on supported destinations, retries, deduplication and audit.
- At least one real end-to-end platform pair; unsupported pairs clearly identified.
- No self-bots or credential/cookie extraction from embedded personal accounts.

## P2: maintainability

- Provider SSO compatibility evidence and configurable reviewed enterprise IdPs.
- Reproducible builds, installer evidence and version-specific release notes.
- Retention/deletion policy and privacy-preserving diagnostics.

Source implementation, mock tests, packaging and real messaging acceptance are
separate milestones. Consult [acceptance.md](acceptance.md) before publishing.
