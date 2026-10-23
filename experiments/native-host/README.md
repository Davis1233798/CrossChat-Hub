# Windows native-window host experiment

This standalone C#/.NET Framework x64 experiment tests **real Chrome window
parenting**, rather than extension compatibility in CEF. It is outside product
packaging. No LINE functionality or cross-platform support is claimed.

`NativeHost` launches only an owned synthetic child or a new Chrome process with
a fresh temporary `--user-data-dir` and `about:blank`. It obtains the launched
process's main HWND, verifies PID ownership, saves parent/style/bounds, applies
`WS_CHILD` and `SetParent`, resizes to the host panel, then detaches and restores.
It never attaches to a discovered existing Chrome/LINE window, sends keyboard or
mouse events, reads a document, accesses accounts, or sends messages.

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

## Next native LINE experiment (requires a separate decision)

An opt-in attach mode would select exactly one user-approved LINE top-level HWND
and verify its executable/PID, capture parent/style/placement, embed without
reading UI or sending input, resize, and restore on explicit detach/normal host
close. It must never terminate LINE or change account/session settings. A robust
version also needs out-of-process watchdog recovery after host failure and a
clear manual detach control before attaching a user's running application.
This mode is **not implemented** by this prototype, and the current running LINE
was left untouched. Actual mentions/forwarding require a separate messaging
adapter and delivery evidence; native window parenting grants no messaging API.
