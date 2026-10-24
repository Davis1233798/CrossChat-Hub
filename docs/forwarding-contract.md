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
connected to an actual personal-account UI adapter**. The desktop shell now
provides composer previews through main-owned drafts and narrow IPC. Existing
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
   `desktop/forwarding-ledger.cjs` supplies a filesystem ledger for the
   main-process-owned directory under Electron `userData`. Composer orchestration
   is connected, but no personal UI adapter is registered. A send exception or insufficient receipt is
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

`desktop/forwarding-drafts.mjs` supplies the main-private draft service, wired
through `desktop/forwarding-ipc.cjs`, preload and the shell composer.
`prepare({text, draftId?, revision?})` generates an opaque
main-owned ID for new compose messages and retains the resolved plan internally.
Editing needs the current revision and invalidates prior preparation, including
late asynchronous results. Responses expose only display-name preview/status.
`execute(draftId, revision)` checks expiry and resolves again; a changed adapter,
chat or member invalidates the plan rather than redirecting. Dispatch is single
use, and ambiguous execution outcomes require reconciliation. The default
adapter registry is empty, so current calls return explicit unsupported previews
and cannot send. Draft lifetime is in-memory; persistent retry/reconciliation
still relies on the ledger and must not reconstruct a new draft to evade it.

For explicit manual forwarding, `captureSelection({text, platform, chatName})`
accepts a user's pasted-content declaration, **not a verified platform message**.
Main generates opaque `selectionId`, capture revision, timestamp and body digest;
display labels never become platform account/chat/message IDs. The body stays
private; the ledger stores neither body nor digest.
`prepareSelection({selectionId, captureRevision, routeText})` requires only a
destination route and uses the captured body unchanged. These selection APIs
are exposed only through the trusted shell's manual-forwarding mode. Source
edits revoke the old capture and unexecuted drafts; the UI states that the
source is manually declared and not platform-verified. Send remains disabled
without a real destination adapter. The same selection and exact destination
share a dedupe key; another destination requires a new explicit resolved preview.
A new manual capture has a new ID, so separate copies of one original message
cannot be deduplicated. Selection sources cannot carry forwarding traces or
participate in unattended bidirectional bridges. Exact target/member checks
remain unchanged; HWND/UIA runtime IDs are never passed off as platform IDs.

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

The filesystem ledger uses exclusive `wx` creation per SHA-256 key and flushes
the reservation before returning a successful claim. Separate processes race
for the same path rather than trusting in-memory locks. Immutable terminal
records store only submission message ID and exact target metadata; arbitrary
adapter fields and message bodies are excluded. Restarted readers interpret an
unsettled or partially written record as `unknown`, without modifying a live
writer's reservation. Keys are never released automatically. Repeating the same
settlement is idempotent; conflicting changes fail. I/O errors propagate before
execution or leave the reservation blocked after execution.

This uses only built-in `node:fs`/`node:path`, avoiding a native SQLite module
and Electron ABI dependency. The local Node runtime is 24.0.2; Electron's
`node:sqlite` availability was not established, so it is not assumed. File
flushes protect against normal process crashes; portable Node APIs cannot
guarantee Windows directory-entry persistence under sudden power loss. This is
not an exactly-once network guarantee. Reconciliation and retention management
remain necessary before an actual send adapter can ship.
