# Slack app setup (maintainers)

This setup is for a maintainer registering CrossChat Hub's Slack app. End users must not be asked to create a Slack app or provide a client secret, access token, or refresh token.

## Registration values

- App name: `CrossChat Hub` (or the approved product name).
- OAuth redirect URL: `http://localhost:43210/slack/oauth/callback`.
- PKCE: enable it in Slack's app settings under **OAuth & Permissions** before using the desktop OAuth flow. Slack treats enabling PKCE as a one-way change; it cannot be disabled without contacting Slack support.
- User token scope: `chat:write` only.
- Bot token scopes: none. Slack's PKCE documentation disallows bot scopes for desktop redirects.
- Do not configure Events API, incoming webhooks, Socket Mode, or other scopes for this desktop user-token flow.

The redirect URL must be identical in the Slack app settings and `desktop/slack-app-config.json`. The current app configuration intentionally has `clientId` and `registeredLoopbackRedirectUri` unset. After registration, the maintainer must provide the real app's public Client ID and set the redirect URI there to the exact fixed value above. The desktop implementation binds that configured port on loopback and serves `/slack/oauth/callback`; do not substitute an ephemeral port, `127.0.0.1`, a different path, or a wildcard URI.

The Client ID is public application identification data, not a secret. It is expected to be present in the desktop app and OAuth authorize URL. Never embed or request the Slack Client Secret for this flow: PKCE uses a short-lived in-memory verifier and `code_verifier` at token exchange. Do not commit actual user access or refresh tokens.

## Dashboard procedure

1. In Slack API app management, create the app in a maintainer-controlled development workspace. The JSON manifest in [`../desktop/slack-app-manifest.json`](../desktop/slack-app-manifest.json) is a minimal starting configuration using Slack's documented manifest fields. It is not a dashboard validation result; Slack performs authoritative schema validation in its manifest editor.
2. In **OAuth & Permissions**, confirm the registered redirect URL exactly matches the value above, add only user scope `chat:write`, leave bot scopes empty, and explicitly enable PKCE. Verify PKCE is enabled before attempting authorization.
3. Save the real Client ID and redirect URI in the desktop app configuration through the maintainer release/configuration process. Keep credentials outside end-user setup; do not insert a Client Secret.
4. For an installation in the development workspace, use Slack's **Install to Workspace** flow. Workspace approval policies may require an admin to approve or install the app.
5. To allow installation in other workspaces, complete Slack's **Manage Distribution** checklist and activate public distribution. This is a separate maintainer action; workspace administrators may still need to approve installation. Marketplace listing/review is a separate step and is not implied by enabling public distribution.
6. Perform any real OAuth validation only after the app is configured and approved. No app registration, OAuth authorization, token issuance, or message sending is performed by this repository preparation.

## Official references

- [Slack: Using PKCE](https://docs.slack.dev/authentication/using-pkce/) — public desktop clients, one-way PKCE enablement, localhost desktop redirect behavior, user scopes only, and code-verifier exchange.
- [Slack: App manifest reference](https://docs.slack.dev/reference/app-manifest/) — supported `oauth_config.pkce_enabled`, redirect URLs, and user/bot scope fields.
- [Slack: Distributing Slack apps](https://api.slack.com/docs/slack-apps-mgmt) — workspace installation, public distribution, approval requirements, and Marketplace distinction.

## Remaining maintainer work

- Register the app in the intended maintainer workspace and verify this manifest in Slack's own editor.
- Make the one-way PKCE enablement decision in that app's Dashboard.
- Obtain the app's actual Client ID and apply it with the fixed redirect URI to `desktop/slack-app-config.json` using the appropriate maintainer configuration/release process.
- Obtain workspace admin approval/installation as required. If users in other workspaces are in scope, complete public distribution and any workspace-specific admin approval; Marketplace publication is separately optional.
- Run a real authorized desktop flow and verify approved message sending before describing Slack API messaging as available.
