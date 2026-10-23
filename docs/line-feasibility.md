# LINE-first feasibility investigation — 2026-10-23

LINE personal chat inside the same CrossChat Hub window is mandatory. External
launch, a Bot/Official Account, identity-only LINE Login, or a screenshot of LINE
does not satisfy it. No production support or release is claimed by this report.

## Findings from three delegated investigations and a local probe

1. **Official client route exists:** the [official LINE Chrome listing](https://chromewebstore.google.com/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc)
   offered LY Corporation's version 3.7.2 when inspected. It describes personal
   messaging, groups, file transfers and Letter Sealing on Chrome, including
   Windows and Mac. [LINE's PC instructions](https://help.line.me/?contentId=50001182)
   describe Chrome login and logout. This is evidence for investigating an official
   extension host, not evidence that Electron or this project can chat.
2. **Electron has an observed blocker:** [Electron's support table](https://www.electronjs.org/docs/latest/api/extensions/)
   promises only a subset of extension APIs. Our unmodified-extension probe below
   failed during initialization. Do not implement fake API responses to turn this
   into a passing login demonstration.
3. **CEF Chrome-style Views is the strongest cross-platform candidate:** the
   [CEF extension issue](https://github.com/chromiumembedded/cef/issues/1947)
   directs full extension support toward Chrome runtime. This is a host capability
   lead, not proof that LINE works. The [current cefclient implementation](https://raw.githubusercontent.com/chromiumembedded/cef/master/tests/cefclient/browser/main_context_impl.cc)
   explicitly falls back to Alloy when Chrome style has a native parent on macOS
   (issue [3294](https://github.com/chromiumembedded/cef/issues/3294)). Therefore
   investigate a CEF Views-owned whole application shell, rather than embedding
   a Chrome-style CEF child in the existing Electron macOS window.
4. **Windows native client embedding is a secondary experiment:** Win32
   [SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)
   supports cross-process parenting, with explicit style and DPI constraints.
   This has not been tested on LINE. HWND replacement, IME, popups, tray state,
   update and restoring the original window on Hub exit remain substantial risks.
   Apple's [addChildWindow](https://developer.apple.com/documentation/appkit/nswindow/addchildwindow(_:ordered:))
   does not document an equivalent arbitrary cross-process parent API. Screen
   streaming is not equivalent to an interactive embedded client.

## Static official-package evidence

The public Google update endpoint returned a CRX3 package for extension ID
`ophjlpahpchlmihnnnihgmmeilfjmjjc`:

```text
https://clients2.google.com/service/update2/crx?response=redirect&prodversion=150.0&acceptformat=crx2,crx3&x=id%3Dophjlpahpchlmihnnnihgmmeilfjmjjc%26uc
SHA256 3722ab02edb0aba49c229399ee8df5b4b5a38c60b76efadadfbae395015eb859
```

The hash identifies these downloaded bytes; a hash alone is not CRX publisher
signature verification. The package was retrieved from Google's endpoint and
unpacked only in ignored developer scratch storage, never added to this repo or
the application package. No private Chrome profile, cookies or credentials were
read. No extension source modification, decompilation or protocol replacement was
performed.

Manifest inspection: version 3.7.2, Manifest V3, module service worker
`background.js`, action button, sandbox pages, permissions `downloads`, `storage`,
`notifications`, `system.display`, `cookies`, and broad website host permissions.
These declarations do not prove that every requested API is on the login path.

## Actual Electron 45.0.0 probe (Windows)

A separate temporary userData directory and persistent test partition were used.
The original unpacked package was loaded with `session.extensions.loadExtension`,
then its `index.html` was opened in a sandboxed, Node-disabled, isolated hidden
BrowserWindow. Popup creation and permission requests were denied. No login was
attempted, QR code captured, or message sent. The probe exited after eight seconds
of observation; the real CrossChat account profile was not used.

Observed result:

```json
{
  "electron": "45.0.0",
  "extensionVersion": "3.7.2",
  "unknownPermissions": ["downloads", "notifications", "cookies"],
  "pageError": "Uncaught TypeError: Cannot read properties of undefined (reading 'onRemoved')",
  "title": "LINE",
  "runningWorkersAtSnapshot": 0,
  "loginAttempted": false
}
```

The unpacked loader generated a different extension ID from the official CRX ID;
original identity/origin handling remains another requirement for future host
tests. No identity workaround was applied. A title and successful loadExtension
call do not prove that the login UI rendered. A zero-worker snapshot does not
prove service workers can never start. The actual initialization error is enough
to reject this unmodified Electron probe as a usable client, not enough to rule
out all possible extension hosts.

## Next implementation experiment and acceptance gates

### Follow-up: original LINE in compiled CEF (Windows, pre-login only)

After the synthetic fixture baseline, a fresh CEF 144 Chrome-style Views profile
loaded the unmodified original unpacked LINE 3.7.2 package. The main window was
initially `about:blank`; the registered extension service worker was observed
before navigating that existing page to the extension's original `index.html`.
No action button, credential, QR scan or login submission was automated.

Observed evidence:

- The background service worker remained listed.
- Main native window ID stayed `1677589399` before/after navigation; only one page
  target was present. Thus this direct-navigation experiment did not create a
  second top-level page window.
- Document title was LINE and the React root had one child, but visible body text,
  inputs, buttons and images were absent. The official login UI was not verified.
- Runtime exception was `Hp: ltsm_not_available`, observed again on reload.
- The original package's `ltsmSandbox.html` iframe target was observed. Resource
  diagnostics showed telemetry-host DNS failures, but no evidence establishes
  those failures as the cause of the LTSM initialization error.
- Unpacked extension ID was `mckobiklbnifjbjheekckfflkmeeacpd`, not the publisher's
  official ID. Whether this affects initialization is a hypothesis, not a proven
  diagnosis. Original signed-package identity/install support is the next gate.

No original extension source, wasm, manifest, authentication or encryption logic
was patched. No private Chrome/LINE profile was used. No QR image, credential or
message content was captured. CEF's diagnostic listener was local to the temporary
test host; production must never expose account debugging this way.

This advances the route from API presence to an actual original-client startup
failure. It does not establish LINE login/chat support, and it does not prove
that other correctly installed/signed CEF or Chrome host configurations fail.

Use a separate experimental CEF Views/Chrome-style shell, keeping current
Electron code intact until feasibility is established:

1. Pin a CEF distribution/version and build Windows x64 and macOS x64/arm64
   samples. Verify sandbox, persistent request context and extension identity.
2. Use our own small MV3 fixture first: service-worker start/restart, action,
   window creation/closing, storage, notification denial and download lifecycle.
   Confirm extension-created content can be hosted in the same shell window,
   rather than opening another top-level browser window. This is a critical
   unproven step, even if CEF supports the APIs.
3. Only after those pass, load the original official LINE package in a disposable
   profile without rewriting its authentication/network/crypto implementation.
   Check initialization and official login UI. Do not patch missing API calls into
   success stubs or intercept a user's password, session or messages.
4. User manually signs in through official UI; verify true rooms, consenting test
   message send/receive, restart/session retention, logout, attachments, IME and
   notifications. Run separately on each target architecture.
5. Add the other web services only once LINE passes. An architecture migration
   must preserve isolation, no-Node remote content, secure navigation, updater and
   installer behavior already verified in the existing branch.

## Distribution/authorization is a separate gate

The [LINE Software Terms](https://terms.line.me/line_PC_terms) reserve software
rights and contain restrictions on copying, modification and third-party
licensing. Public documents reviewed do not establish permission to bundle the
extension in CrossChat's installer. A local host experiment, user installation of
an official extension, and distributing a repackaged extension are different
questions. Obtain applicable distribution/host authorization before publishing
bundled LINE software; no contact or agreement was made during this investigation.
This is a product gate requiring confirmation, not a claim that all embedding is
categorically forbidden.

The [public technical partner program](https://tw.linebiz.com/partner-offer/tech-partner/)
does not by itself establish availability of a personal-chat SDK. Ask specifically
about original-extension hosting, supported runtime, installation, updates and
distribution. The user has test accounts but currently no LINE authorization
arrangement. Continue technical host validation in parallel; lack of an existing
agreement must not be misreported as proof of technical impossibility.
