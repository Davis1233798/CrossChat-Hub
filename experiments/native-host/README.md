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
