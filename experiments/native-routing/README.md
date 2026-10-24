# Read-only native routing sidecar experiment

This product-owned .NET Framework x64 helper uses public Windows UI Automation.
It contains no send, click, keyboard, credential, private LINE API, cookie or
protocol code. It does not package the agent's computer-use runtime. It is not
registered as a working LINE adapter, and is not in production packaging.

Developer build: `powershell -NoProfile -File experiments/native-routing/build.ps1`.
Owned fixture check: `node experiments/native-routing/smoke.mjs`.
Main-owned client end-to-end check: `node experiments/native-routing/client-smoke.mjs`.
Outputs are ignored under `build/bin/native-routing/`; fixture startup metadata
is written only to its own temporary directory. No actual chats are used.

The trusted main process would launch the helper with exactly five arguments:
verified target PID, process start UTC ticks, absolute executable path, HWND and
a fresh 48-character nonce. These must not come directly from renderer IPC.
Each operation revalidates executable path/start time, OS session, HWND owner
and UIA process. This identifies an existing process/window, **not a platform
account or conversation ID**. Executable publisher verification and explicit
user window selection remain integration prerequisites.

stdin/stdout carry bounded JSON lines (32768 characters, no network listener):

```json
{"v":1,"id":"1","op":"probe","nonce":"<nonce>"}
{"v":1,"id":"2","op":"observe-selection","nonce":"<nonce>"}
{"v":1,"id":"3","op":"observe-header","nonce":"<nonce>","path":[{"automationId":"chatHeader","controlType":"Text"}]}
```

The helper validates the initial witness and emits a nonce-bound `ready` record
before accepting one observation request. The main-owned client verifies that
record before sending the request; it never treats process startup timing as
readiness. The client E2E uses only an owned WPF fixture, which activates and
selects its immutable test text on a fixture-controlled request. Its test-only
selection path names one exact direct child by AutomationId and control type;
the helper also requires the target window to remain the foreground root and
the selected control to own keyboard focus. Normal product witnesses remain
unbound unless trusted main-process code explicitly provides a path.

`probe` returns only the explicit target window title and process witness.
`observe-selection` reads one nonempty TextPattern selection only when the
keyboard-focused element belongs to this target window. Focus elsewhere fails
closed; unsupported TextPattern is not replaced by ValuePattern/full text.
`observe-header` follows at most eight exact direct-child AutomationId/control
type steps and requires exactly one match at every step. It does not guess a
header from arbitrary text or scan other conversations. Responses explicitly
return null platform chat/message IDs; a visible label never becomes such an ID.

There is no content logging or saving in the helper. stdout contains requested
window/selection/header content and must remain a private pipe, never a general
diagnostic log. Errors are fixed safe codes rather than exception/argument dumps.
The caller must apply a response deadline and handle a stalled UIA provider;
this initial helper cannot preempt a hung native provider internally.

Owned Windows tests established a real probe and exact header observation.
The unattended WPF fixture probe returned `focus-outside-target`, correctly
refusing to inspect another focused application. A subsequent focused test used
the computer-use skill to activate only the owned fixture and verify its edit
control and selected text. The product sidecar then returned `ok: true`, exactly
`Only owned selected text`, provenance `ui-selected-text`, a null platform message
ID, and exit code 0. The fixture closed normally; neither test process remained.
No provider workaround or full-text fallback was needed. This establishes that
the earlier WPF failure was the focus precondition, not missing TextPattern in
that fixture. Earlier WinForms generic failures still do not establish its
provider capabilities. This selected-text success is specific to the owned WPF
control; it is not a guarantee for arbitrary applications or LINE providers.
No actual LINE window was observed.

A later product-client diagnosis established that its generic refusal occurred
after request decoding, within observation, rather than a JSON/nonce framing
failure. The helper now reports only fixed phase codes for validation, focus,
focused-owner/ancestry and TextPattern selection failures; the client preserves
those allowlisted codes and suppresses arbitrary exception text. The next
focused fixture attempt encountered an explicit computer-use user-input conflict
and changed fixture contents, so UI input stopped. That run is not a controlled
selection test and does not establish a repair. Its fixture exited normally with
no helper/fixture process remaining. A known, uncontended owned selection is
still required to isolate the exact provider phase and prove the product client.

Future LINE dryrun must first inspect its actual provider through the applicable
computer-use skill, then explicitly authorize a product test against that
selected window. This synthetic result establishes neither a valid LINE header
selector, account identity, recipient resolution nor cross-platform forwarding.
