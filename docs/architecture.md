# CrossChat Hub architecture (0.4 development)

The active desktop process runs `desktop/main.cjs`, loads a local sandboxed shell,
and hosts one visible WebContentsView at a time. Previously opened web views stay
alive, each in a separate persistent provider session. The local preload exposes
only tab switching, reload, curated official links, status events, confirmed
per-provider local data clearing and quit.
Provider pages have no preload/native API and no Node integration.

`desktop/navigation.cjs` applies navigation, redirect and recursive popup policy.
`desktop/permissions.cjs` independently checks official origins for device access;
a permitted SSO navigation does not grant device access to that identity provider.
The local shell records only the last selected tab, not verified login state.
Titles can supply an unverified unread count, never proof of authentication.

`desktop/lifecycle.cjs` coordinates one bounded shutdown across window close,
application quit and installer close requests, flushing configured sessions before
exit. `desktop/session-data.cjs` coordinates confirmed local resets and rejects
non-web/arbitrary profiles. `desktop/reset-intent.cjs` persists content-free
pending markers in userData so a failed/interrupted reset cannot silently reopen
the target profile after restart. These are local browser-storage operations,
separate from provider logout or server-side device authorization revocation.

Confirmed services: Telegram, Discord, Slack, WhatsApp and LINE. LINE has no
implemented embedded client. Official website tabs are a manual interaction
workspace, not a unified message API or an automatic cross-platform notifier.

## Legacy optional backend

`src/runtime.mjs`, `src/app.mjs` and `public/` retain the earlier standalone
Bot/OAuth dashboard. The current desktop does not start it. Its SQLite encrypted
credentials, webhook verification, Gateway, alias mapping and outbox are separate
from browser profiles. Demo delivery remains a local simulation.

Room bridges forward explicitly configured text through authorized bot APIs.
Delivery is at least once; a remote acknowledgement followed by a local crash
can duplicate messages. Identity OAuth alone does not grant private-chat access.
The backend has not been connected to the embedded websites and must not be
presented as universal personal-account messaging.

See [desktop.md](desktop.md) and [acceptance.md](acceptance.md) for validation limits.
