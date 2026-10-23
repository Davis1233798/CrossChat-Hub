# Same-window Views overlay (experimental)

Select `-AppMode synthetic` explicitly. The separate [official-store/pre-login
mode](LINE-PRELOGIN.md) is built with `-AppMode line-prelogin`; neither is production
LINE support. Rebuilding replaces the scratch sample, never the repository sources.

This source overlay replaces the pinned upstream sample's `simple_app.cc` and
`cefsimple_win.cc`. The Windows entrypoint is committed here, including the
profile and diagnostic settings; rebuilding no longer depends on edits hidden
in ignored scratch storage. The adjacent CEF license covers derived sample code.
This is an experimental Windows overlay, not a standalone or production shell.

## Rebuild without running

Prerequisites: VS2022 Build Tools with MSVC x64, Windows SDK, CMake >= 3.21,
Python, and an existing upstream cef-project checkout at
`3aec7049cf63a36876d7a6ef538842d6af314482` with its downloaded
`144.0.6+g5f7e671+chromium-144.0.7559.59_windows64` distribution.
Use a dedicated scratch checkout; the command replaces two sample files there.
From the CrossChat-Hub root, run:

```powershell
& ./experiments/line-host/native/build.ps1 `
  -AppMode synthetic `
  -CefProject ./build/bin/cef-project `
  -BuildDirectory ./build/bin/cef-project-build `
  -CMake 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
```

The script checks checkout revision and CEF version, applies both overlays,
configures VS2022 x64 with `USE_SANDBOX=ON` and `WITH_EXAMPLES=OFF`, and builds
Release target `cefsimple`. It does not start the executable or install anything.
CEF's upstream build sets sandbox LPAC ACLs on its output directory.
2026-10-23: this exact script configured, compiled and linked successfully using
MSVC 19.44 and Windows SDK 10.0.26100.0. The upstream ATL-unavailable and unused
delay-load linker warnings remain. The host was not executed.

## Isolated launch contract (runtime verification pending)

The browser process requires `--crosschat-profile=<absolute-path>`. The path
must name a **nonexistent direct child of the Windows OS temp directory**, with
a basename starting `crosschat-line-host-` and a nonempty suffix. For example,
compute the argument with `Join-Path ([IO.Path]::GetTempPath())
('crosschat-line-host-' + [guid]::NewGuid())`; do not create that directory first.
The entrypoint atomically creates it and returns exit code 2 if it already
exists, so an existing Chrome/LINE/account profile cannot be selected or reused.
Do not delete an existing profile merely to get past this check. This fresh-run
contract is for synthetic compatibility tests; it does not implement the eventual
production requirement of persistent personal sessions.

Sandbox information is mandatory; missing sandbox bootstrap or explicit
`--no-sandbox`, `--disable-web-security`, `--ignore-certificate-errors`,
`--user-data-dir`, `--remote-debugging-port`, or `--remote-debugging-address`
arguments cause exit code 2. The diagnostic server is disabled by default.
`--crosschat-diagnostics` explicitly enables port 19377 using the pinned CEF
loopback default. Before connecting the inspector, verify that the actual TCP
listener belongs to this host and binds only to `127.0.0.1` / `::1`; stop if it
does not. The loopback binding of this revised entrypoint is still unverified.
Load only the parent directory's owned MV3 fixture with `--load-extension`.
The fixed fixture start URL and registration/readiness limits below still apply.

The browser starts at `about:blank`. Its internal CEF DevTools observer enables
`Runtime` events and `Target` discovery, and checks the initial target snapshot.
Only the exact owned fixture service-worker URL triggers navigation to the fixed
probe URL. The probe emits a structured readiness console event only after its
capabilities reply has `starts >= 1` and `worker === true`. The host accepts it
only from a default execution context whose observed origin is the fixed fixture
origin, while the main frame is at the exact probe URL; it also validates the
capabilities boolean fields. No JavaScript is injected into LINE or other pages.
Protocol dispatch/error, agent detach, or a 30-second deadline emits a structural
`fixture-readiness` event with `ready:false`; elapsed time never means success.
This mechanism uses CEF's internal DevTools API and needs no diagnostic listener.
On browser close, the registration is released and the observer drops its browser
reference; the queued deadline task then becomes a no-op. It retains no browser
after readiness or failure either.

2026-10-23: compiled and linked against the pinned CEF 144 headers. **Not run**:
whether page-scoped `Target` discovery in this CEF version can enumerate extension
workers remains unknown. A timeout is a failed readiness result, not proof that
the extension cannot run. No login or same-window success is established here.

Ordinary popup Views
are added above the opener inside the same top-level Window using fill layout.
The callback emits a structural sameViewsWindow diagnostic, without URL contents,
credentials or message data. That callback alone is not acceptance evidence:
run the parent inspector for both paths and visually check display, resizing,
focus, closing a child, and closing the host without residual processes.

The worker chrome.windows.create path may bypass this callback entirely;
GetDefaultClient only assigns a client and does not attach the resulting window.
The experimental client now tracks all created browsers and asks every browser
to close gracefully when the host window closes, including escaped worker
windows. It preserves upstream OnBeforeClose bookkeeping and never force-kills
the process. This guard compiled successfully; cancellation, re-entry and
residual-process behavior still require live tests.
Extension registration/readiness now uses the experimental event-driven mechanism
above. Multi-view close lifecycle and popup restoration are unverified.
The popup delegate now remembers each attachment's parent window and removes its
overlay in `OnBrowserDestroyed`, before upstream lifespan bookkeeping runs. It
then requests focus for the uppermost remaining live BrowserView. This avoids
leaving cleanup to SimpleHandler, which only tracks browsers, and avoids keeping
a stale opener browser for focus restoration. A destroyed/detached view or window
is checked before hierarchy access. This follow-up compiled and linked on Windows
x64 Release with the same pinned CEF build; close/focus behavior is still untested.
Do not use this host for account login or real messages. It has not been launched
or visually verified, does not implement tabs, and is excluded from packaging.

The prior isolated host launch was rejected by automatic approval review
(`blocked by policy`, no more specific reason). No alternative execution method
was used to bypass that rejection. Runtime verification remains pending.
