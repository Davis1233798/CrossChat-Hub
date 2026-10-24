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
