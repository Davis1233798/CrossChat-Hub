# Windows native-window host experiment

This standalone C#/.NET Framework x64 experiment tests **real Chrome window
parenting**, rather than extension compatibility in CEF. It is outside product
packaging. No LINE functionality or cross-platform support is claimed.

`NativeHost` launches only an owned synthetic child or a new Chrome process with
a fresh temporary `--user-data-dir` and `about:blank`. It obtains the launched
process's main HWND, verifies PID ownership, saves parent/style/bounds, applies
`WS_CHILD` and `SetParent`, resizes to the host panel, then detaches and restores.
It never sends keyboard or mouse events, reads a document, accesses accounts, or
sends messages. An explicit approved LINE attach mode is described below.

Developer build: `./experiments/native-host/build.ps1`. Output is ignored under
`build/bin/native-host/`. Run that EXE with `--output <absolute-json-path>` for
the synthetic fixture; additionally pass `--chrome <absolute-chrome.exe>` for a
fresh Chrome instance. `--hold-seconds 60` extends the embedded display for manual
inspection (range 2–120 seconds). Closing the host restores the child early.
Chrome deliberately remains open in its isolated profile after restoration;
the synthetic child is closed normally. Temporary profiles are not deleted.

## Observed on 2026-10-23

- Windows x64 compiler succeeded using the installed .NET Framework compiler.
- Synthetic cross-process fixture: native read-back confirmed embedded parent
  and child style, exact resized client dimensions, restored parent/style; exit 0.
- Installed Google Chrome **156.0.8078.47**, fresh profile: the same three native
  read-back checks passed, exit 0.
- A second Chrome run held for 60 seconds. Computer Use captured the uniquely
  selected host window: the outer **CrossChat native host experiment** titlebar
  surrounds Chrome's tabs, address bar and blank page inside its content panel.
  This is direct visual evidence of Chrome embedding, rather than HWND-only
  inference. Chrome's own custom window controls remain visible inside the host.
- After the 60-second run the result again reported all three checks true; no
  NativeHost process remained, and the isolated Chrome browser stayed running
  after restoration. Its updater emitted access-denied IPC messages; this did
  not prevent the observed embedding, but normal update behavior is unverified.
- No existing Chrome session or running LINE process was attached or inspected.

These results do **not** establish keyboard focus, Chinese IME, clipboard,
screen-reader behavior, DPI changes, modal/pop-up hosting, GPU recovery, or LINE
extension installation/login/real-message delivery. The host is a short-lived
experiment, not a robust shipping container; crash recovery and platform updates
still need design. See Microsoft's
[SetParent documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)
for cross-process DPI behavior and style requirements.

## Native LINE attachment (explicit developer experiment)

`--attach-pid <approved-pid> --attach-hwnd <approved-decimal-hwnd>` opts into
one explicitly identified native LINE window. The executable path and HWND PID
must match; a minimized/hidden window is refused. Before this mode is used,
identify the correct main window and exclude login/authentication windows.
It captures parent/style/placement/bounds/visibility and performs the same
short-lived embed/resize/restore sequence. It never closes the attached LINE.

On 2026-10-23, after necessary Computer Use window classification (no dialogue
analysis or saved screenshot), the existing native LINE main window was tested:
embedded parent/style and resized dimensions read back true; restored parent,
style, bounds and visibility read back true; host exit 0. Afterwards LINE was
still responsive with its original PID/HWND, and no NativeHost process remained.
This is **native structural evidence only** for LINE, not visual embedding,
keyboard/IME, mentions, forwarding or real delivery validation.

There is **no independent restore watchdog**. Do not repeat existing-app tests
until crash recovery is implemented and reviewed; a killed/crashed host can
leave a third-party window in an undesirable state. A shipping version also
needs a clear manual detach control. Actual mentions/forwarding require a
separate messaging adapter and delivery evidence; parenting grants no API.

## Hard-crash study: post-exit guardian cannot guarantee recovery

`CrashStudy.exe --output <absolute-json-path>` is an independent controller plus
two owned synthetic fixture processes. It has **no external-application attach
interface**. It captures the child's original state, embeds it in the owned
host, intentionally hard-terminates only that host, checks the original child
HWND/PID, and attempts restoration only if that HWND still exists. Fixture
cleanup is reported separately from restoration; an orphaned fixture process
may require forced cleanup, which is never counted as normal closure.

Actual Windows run on 2026-10-23 produced `embedded=true`,
`syntheticHostHardExit=true`, **`childWindowSurvived=false`** and
**`guardianRestoreVerified=false`**, exit 1. The child process initially remained
without its original HWND and was cleaned up using its verified owned fixture
path/command line. No LINE or Chrome was used in this crash experiment.

This is a negative reliability result, not a passing recovery test. Merely
waiting for host death and then calling SetParent is insufficient here: once
Windows has destroyed the original child HWND, no guardian can restore it.
Microsoft's [DestroyWindow documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-destroywindow)
states that parent destruction also destroys child windows, while direct
DestroyWindow calls cannot target another thread's windows. The actual crash
study resolves why the latter sentence must not be assumed to protect this
cross-process parenting arrangement.

A different design must keep the real parent HWND in a persistent broker
process. Nesting that broker window under the Hub would still put it in the
Hub's destruction chain and does not solve the failure above.

## Top-level broker: synthetic controller-crash isolation

`BrokerStudy.exe --output <absolute-json-path>` (built by `build.ps1`) implements
the minimum **inverted ownership** experiment. The study process is the broker
and owns the actual top-level shell HWND. It launches two owned synthetic
processes: a controller UI and a chat window. Their HWNDs become sibling
`WS_CHILD` windows of the broker root; neither is the other's ancestor. Both
have the same native top-level ancestor, so this is actual native parenting,
not a floating window aligned over another application's rectangle.

The broker intentionally terminates only its own controller fixture, waits for
that process to exit, verifies that its root and the original chat HWND/PID
still exist, then detaches the chat and restores its parent, style, placement
and visibility. Termination is restricted to processes it launched, retaining
their Process handles and checking PID-associated HWND ownership and start
time. It accepts no external PID, HWND, Chrome path or LINE attachment option.

Actual Windows x64 run on 2026-10-24 returned exit 0:

```json
{"sameTopLevelBrokerRoot":true,"ownedControllerHardExit":true,"brokerRootSurvived":true,"chatHwndSurvived":true,"chatRestoreVerified":true,"chatNormallyClosed":true,"forcedOwnedFixtureCleanup":false,"error":null}
```

No `BrokerStudy` processes remained after the run. This is a native structural
controller-crash result, not visual validation or a LINE test. It does not
establish IME, focus, DPI, popups, GPU recovery, delivery, timeout behavior or
recovery from a broker crash. Killing the broker/root itself can still destroy
the embedded chat HWND by the already-observed destruction chain.

Adopting this architecture requires the broker to become the product's
top-level shell owner, with Hub/controller content embedded inside it. Adding
a broker-owned child panel inside the current Hub is insufficient. The current
Electron product has **not** been refactored to this architecture; launch/IPC,
controller monitoring outside this intentional-crash study, manual detach,
controller restart and broker-failure policy remain design work. Existing-app
crash or attachment retries remain out of scope until these risks are addressed.

## Actual Electron Hub in the broker (Windows developer study)

`desktop/native-broker-study.cjs` now connects the real `desktop/main.cjs` and
its existing shell/composer to the fixed, locally compiled `HubBroker.exe`.
This is opt-in with `CROSSCHAT_BROKER_STUDY=1`, unpackaged Windows only. Build
with `./experiments/native-host/build.ps1`, set that environment variable in a
developer terminal, then run `npm run desktop`. Clear it afterwards to use the
normal app. `CROSSCHAT_BROKER_TEST_MODE` defaults to `manual`; `normal` requests
the normal flush/quit after attachment and a resize check, while `crash` exits
the isolated Electron controller abruptly with code 73, bypassing its normal
shutdown path. These modes do not attach any existing application.

The flag is processed before the single-instance lock and all profile-backed
stores. A fresh temporary `crosschat-broker-hub-*` profile and session directory
are created for every run. All web service views load only a random-path page
on this run's bound `127.0.0.1` HTTP server; navigation/redirects/popups are
blocked, and external links/profile clearing are disabled in this study.
The original LINE limitation panel remains accurate. No real messenger
session, login dialog, user LINE/Chrome process or message is inspected.

The broker owns the top-level native root and a content panel. The actual Hub
HWND is a left child and a broker-launched synthetic chat HWND is its right
sibling, with the Hub's entire composer visible. This is a stage toward the
desired LINE content-tab integration, not that final layout or LINE support.
The sidecar is a fixed development path, not a renderer-supplied executable.
Private inherited stdio carries versioned JSON lines with a random nonce and
4096-character line limit. Main obtains its HWND from `getNativeWindowHandle`;
broker checks HWND ownership, controller PID and process start ticks before
parenting. It accepts only attach/shutdown/resize-check commands. There is no
socket, download, arbitrary app path or third-party attach mode.

The broker manifest uses PerMonitor awareness to match the observed Electron
45 HWND (context -3). The first PerMonitorV2 attempt was correctly refused
before parenting (broker -4 versus Electron -3); strict context equality stays
required. Layout uses broker native physical coordinates and Electron's own
resize handling keeps its web views in DIP. A resize check reads back child
outer rectangles and verifies adjacency, height and the shared root. Focus
buttons request Hub focus or fixture focus, but keyboard/IME behavior and
mixed-monitor DPI transitions remain unverified.

Normal root closure requests the existing Hub flush/quit, leaves the root
alive while waiting, then restores the synthetic fixture after the controller
exits. The broker also polls the retained controller Process handle every
100 ms to cover abrupt exit, restores fixture parent/style/placement/visibility,
then closes the owned fixture normally. Broker is a detached WinExe process:
the initial shared-console prototype died with controller console teardown
and left an orphaned synthetic process; it was cleaned up by verified owned
PID/start time. This failure is not counted as recovery success.

Observed Windows x64 on 2026-10-24 after those corrections:

- Build of `HubBroker.exe` and JavaScript syntax checks passed.
- Normal isolated run and abrupt-exit isolated run both reported all checks
  true: attachment/shared root, equal DPI, resize, controller exit, surviving
  broker root and original fixture HWND, exact fixture restoration and normal
  fixture closure. Errors were null; no `HubBroker` processes remained.
- A separate manual run survived an OS termination of only its recorded owned
  Electron controller PID/start time; fixture restoration/normal close passed.
- Computer Use selected and activated the uniquely returned broker root. Its
  screenshot visibly showed the actual Hub, tabs, loopback page and full
  composer on the left, and the owned native fixture on the right. No screenshot
  is saved to the repository. Root Alt-F4 requested Hub quit and restoration;
  the study shell was then closed normally. No real chat UI was operated.
- With the flag absent, `electron scripts/desktop-smoke.cjs` passed the existing
  visible-window/tab/composer/LINE-limitation/normal-close checks in its own
  temporary smoke profile.

The helper is included with source but the compiled .NET Framework sidecar is
not packaged or released. Packaged/non-Windows flag activation fails closed;
missing fixed binary fails before window/server startup. This remains a
developer study: broker hard-crash safety, native failures beyond the injected
rollback points, hung controller recovery, complete focus/DPI behavior, signed
distribution and actual LINE tab integration are not established. Do not use
this sidecar to attach existing LINE/Chrome windows.

Partial attachment now saves Hub parent/style/placement/visibility and marks
each HWND changed **before** mutation. Errors and unexpected stdin EOF roll back
fixture then Hub, verify original state while Hub remains alive, and only then
acknowledge failure. Hidden Hub visibility is restored separately from its
placement (an unshown Electron HWND can still report `SW_SHOWNORMAL`). Failed
rollback keeps the broker root alive; it cannot be closed while changed children
remain attached. Main's existing shutdown preserves the study failure exit code.

Run `node experiments/native-host/failure-smoke.mjs` after building. Four actual
isolated Hub runs on 2026-10-24 injected failures after Hub parenting, fixture
parenting, initial resize, and stdin EOF. Each retained `success=false` and its
error, restored the live Hub and any changed fixture, closed the fixture
normally, and exited controller with code 1. Reverse rollback order was checked;
no parent was killed to manufacture recovery and no broker remained. Two unit
tests cover absent-flag isolation and packaged-mode early rejection; ordinary
desktop smoke also passed. These checks do not establish broker-hard-kill
recovery or recovery from every possible native API failure.
