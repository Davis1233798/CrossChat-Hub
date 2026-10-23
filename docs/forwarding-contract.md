# Personal-chat forwarding integration contract

The requested destination syntax is `@line:群組名 後文` or
`@line:群組名:人名 後文`. The latter requires a real native member mention,
not literal `@人名` text. The command is at the beginning of a Hub composer
message. Detecting it inside an external client is a separate ingress adapter.
Names containing spaces or colons use JSON-style double quotes:
`@line:"工作 : 台灣":"王 小明" 下午好`. Quotes and backslashes inside names
use `\"` and `\\`. The body after the separating whitespace remains text,
including any later route-looking strings. Group names are case-sensitive.

`src/forwarding.mjs` provides the routing and forwarding seam. It is **not yet
connected to desktop tabs or an actual personal-account UI adapter**. Existing
`src/bridge.mjs` and its Bot/OA outbox retain their separate administrative
purpose; they cannot resolve personal LINE group names or native mentions.
Extended `@line:group:person` syntax is excluded from the legacy alias parser,
so it cannot accidentally send a DM to alias `group`.

1. `parseChatRoute(text)` parses the destination and message body.
2. `prepareForward({ route, source, attachments, trace }, adapter)` resolves a
   single exact target. Forwarding an existing message requires a source with
   `platform`, `accountId`, `chatId`, and `messageId`. A new Hub composer message
   instead uses `{ kind: 'compose', draftId }`, with a main-process-generated
   local draft ID; it never invents a message from another platform. Preserve
   this ID across retries, and create a new one for an intentional new send.
   The local draft and external-message dedupe namespaces are distinct.
   Adapter target IDs must identify the logged-in personal account
   and exact chat. Duplicate names require selection outside this module.
3. A personal adapter exposes `platform`, `accountKind: 'personal'`,
   `capabilities: { sendText, nativeMention, attachments }`,
   `resolveChat(name)`, `resolveMember(target, name)`, and `execute(plan)`.
   Resolvers return arrays; zero or multiple matches are rejected. A mention
   resolves to `memberId` and is mandatory. Attachment entries retain `id`,
   `name`, `mimeType`, and byte `size`; adapters own access to the local content.
   Unsupported attachments or mentions fail before execution, never disappear.
4. `executeForward(prepared, adapter, ledger)` needs a persistent ledger with
   atomic durable `claim(dedupeKey)` and `settle(key, outcome)` operations.
   No production ledger or personal UI adapter is supplied yet. Test doubles
   prove orchestration only. A send exception or insufficient receipt is
   `unknown`, stays claimed, and requires target-chat reconciliation before
   retry. It must not be automatically retried like the old Bot outbox.
5. Execution returns `submitted` only with the exact target and target message
   ID, plus `nativeMentionIds` for required mentions and `attachmentIds` for
   included attachments. It never asserts recipient
   delivery or read status. Adapters must establish that evidence from the
   actual client, not fabricate receipts from clicked buttons or typed text.

The trusted main process owns parsed/resolved plans, draft IDs and ledger keys.
Renderer IPC may submit composer text and reference a draft, but must never
accept an arbitrary renderer-supplied `prepared` plan, target ID or dedupe key
for execution. This module is an internal orchestration boundary, not an IPC
authorization layer. Plans must be revalidated after account/chat changes.

Forwarding keeps the original platform/account/chat/message tuple in `trace`,
plus visited chats. Same-chat, returning-to-origin, visited-chat and eight-hop
routes are blocked. The stable key covers original source, exact destination
and member. Preserving the trace and durable ledger across restarts is required
for actual loop and duplicate protection; plain-text echo matching cannot
replace provenance. An ingress adapter that cannot correlate forwarded echoes
must not enable unattended bidirectional forwarding.

No account was accessed and no message was sent to test this module. Actual
LINE selection, mention notification, attachment transfer and cross-client
end-to-end forwarding remain unverified.
