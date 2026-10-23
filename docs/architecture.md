# CrossChat Hub v0.2 architecture

```mermaid
flowchart LR
  SL[Slack OAuth + Events API] --> IN[Normalized ingress]
  TG[Telegram signed webhook] --> IN
  LN[LINE signed webhook] --> IN
  DI[Discord Interactions] --> IN
  GW[Discord Gateway WebSocket] --> IN
  IN --> DB[(SQLite encrypted credentials + deduped messages)]
  DB --> ME[@platform:alias identity resolver]
  DB --> BR[Explicit room bridge rules]
  ME --> O[(durable outbox)]
  BR --> O
  O --> S[Platform Bot/Channel Senders]
  UI[Electron desktop / localhost dashboard] --> DB
```

The HTTP server also supports an optional standalone service/Docker mode; no public
network listening by default. OAuth additions: Slack v2 installation with state,
encrypted bot token, optional refresh token rotation; Discord user OAuth with state,
PKCE, verified user mapping (OAuth bearer discarded); Discord Guild bot install URL.

A bridge rule binds one source connection and room to one target connection and
room. Create a second reverse rule for two-way sync. Webhook `(connection,event)`
unique index handles retries; an outbox `(message,bridge-rule)` unique index prevents
double sends. Generated outbound bot messages are ignored on incoming adapters.
Accidental bot echo from unexpected third-party integrations may still produce
loops; deploy carefully with explicit, consent-based room allowlists.

Deliveries are **at least once**, not strictly exactly once; remote API ACK after
sending but before local completion can duplicate a message on process crashes.
Only new plain-text messages are forwarded; attachments, edits, thread mapping,
per-message delete, encryption E2E and impersonating native @mentions are **not**
implemented. Direct messages require actual platform-specific bot permissions.

## Required permission/privacy model

The administrator manually configures all bridges, and any connection can only
read/write what its official Bot token can access. OAuth identity verified mapping
is preferable to manually inserted user IDs. Do not bridge private employee/team
channels without consent, retention rules and organization approval. Metadata
such as user IDs and message contents are stored in local SQLite.

Production hardening still required: multi-tenant separation, audit logging,
retention/deletion, rate-limit coordination, delivery leases, secure/public webhook
gateway and external provider E2E testing.
