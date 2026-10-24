# Read-only native routing sidecar experiment

This product-owned .NET Framework x64 helper uses public Windows UI Automation.
It contains no send, click, keyboard, credential, private LINE API, cookie or
protocol code. It does not package the agent's computer-use runtime. It is not
registered as a working LINE adapter, and is not in production packaging.

Developer build: `powershell -NoProfile -File experiments/native-routing/build.ps1`.
Owned fixture check: `node experiments/native-routing/smoke.mjs`.
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
Selection observation returned `focus-outside-target` in the final WPF fixture
probe; therefore actual selected-text acquisition is **not established**. This
is the guard refusing to inspect another focused application, not evidence that
the WPF provider lacks TextPattern. Earlier WinForms generic failures also do
not prove provider support or lack of it. No actual LINE window was observed.

Future LINE dryrun must first inspect its actual provider through the applicable
computer-use skill, then explicitly authorize a product test against that
selected window. This synthetic result establishes neither a valid LINE header
selector, account identity, recipient resolution nor cross-platform forwarding.
