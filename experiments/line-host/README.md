# LINE host experiment

This directory contains only our own synthetic MV3 fixture, no LINE software.
It is not included in production packaging. The current application stays Electron.

The fixture tests the APIs needed for evaluating a host for the official LINE
extension. API presence is not evidence that its implementation works. No device
permission, notification, download, cookie access, account login or message sending
is performed. Two separate controls exercise ordinary `window.open` and a
service-worker `chrome.windows.create`; they must be assessed independently.

Initial host candidate: upstream cef-project commit
`3aec7049cf63a36876d7a6ef538842d6af314482`, using its pinned CEF
`144.0.6+g5f7e671+chromium-144.0.7559.59`. This is an isolated compatibility
baseline, not a supported/current security version for release.

Build the unmodified official `cefclient` sample with VS2022 x64/Release in ignored
`build/bin/cef-project` scratch storage. Use Chrome-style Views (not Alloy, not
windowless) and a fresh cache directory. Load only this unpacked fixture with
`--load-extension=<absolute-fixture-path>`. The extension action opens its probe.
Do not reuse a real Chrome/LINE profile. Do not disable the sandbox or certificate
validation to make a test pass.

Record actual worker initialization and storage values, then inspect both popup
paths: native window count, `CefBrowserView::GetForBrowser`, callbacks and whether
the child is attached inside the existing Views hierarchy. A separate Chrome
window appearing is a failed same-window requirement even if APIs work.

CEF exposes `OnPopupBrowserViewCreated` for ordinary popup BrowserViews, but an
extension-worker-created Chrome window may follow a different path. No supported
existing-browser-to-Views attachment API has been established by this research.
If worker windows escape, evaluate directly hosting the original extension page
without rewriting it, or an upstream CEF change; do not report success from an
ordinary-popup test alone.

Sources and original-extension probe evidence: [LINE feasibility](../../docs/line-feasibility.md).

## Actual Windows baseline result

2026-10-23: the pinned upstream sample configured and built as VS2022 x64 Release
with sandbox ON. Only the sample's Windows initialization was locally augmented
to require `--crosschat-profile=<new-absolute-temp-directory>`, assign
`settings.root_cache_path`, and set `settings.remote_debugging_port = 19377`.
The debugging listener was verified at 127.0.0.1 only. This is diagnostic code,
never a production configuration. No sandbox/certificate disabling flag was used.

The fixture public manifest key fixes its test ID to
`hcmjeeijoifmcgjhocekmfmepgijdjgb` (no private key is stored or needed).
Start the built sample with the profile option above, absolute `--load-extension`
path, and `--url=chrome-extension://hcmjeeijoifmcgjhocekmfmepgijdjgb/probe.html`.
The initial navigation occurred before extension registration and was blocked;
after observing a registered worker, reloading the fixture page succeeded.
Production must handle extension readiness explicitly rather than rely on a delay.

`node experiments/line-host/inspect-cef.mjs` inspects this fixture only through the
owned local debugging endpoint, then requests a service-worker popup and records
window IDs. It must never be used with a real account profile or messenger page.

The inspector now defaults to exercising both popup paths. Pass `ordinary` or
`worker` to isolate one path, using a fresh fixture session for each run. It waits
for the actual child target, compares main and child CDP window IDs (not IDs from
different APIs), and exits unsuccessfully if either child escapes the main
window. Existing child targets are rejected to avoid stale results. This revised
inspector has passed syntax validation and the transport regression tests below;
its two-path CEF runtime result remains pending. Earlier window observations
below came from the original inspector.

Run `node --test experiments/line-host/tests/*.test.mjs` from the repository root
for 15 isolated mock regressions. These execute the actual inspector with a
substitute CDP transport, covering both paths and single-path selection, separate
native window rejection, worker creation failure, socket closure, request timeout
and cleanup. A worker test delays the initial storage write to verify that its
capabilities response waits for initialization. Readiness tests reject missing,
invalid or failed worker responses. The tests do not start CEF or
connect to an endpoint and are **not evidence of native hosting or LINE support**.

Observed fixture capabilities: worker initialized, local storage persisted its
start counter, and windows.create/onRemoved, downloads, notifications, cookies
and system.display methods were present. `chrome.windows.create` really returned
a created window. Main window ID was 1000696966; worker child ID 1000696968 with
680x480 bounds. They were different native Chrome windows, so **same-window
acceptance failed** in the unmodified sample. API presence does not establish
notifications/downloads/cookie operations, and no such side effect was exercised.

This advances the investigation from documentation to a compiled host baseline;
it is not a LINE client, not a complete CEF shell, and not macOS evidence. The
next experiment must own the Views hierarchy and test ordinary popup callbacks
separately from extension worker windows. No official LINE extension was loaded
into CEF during this baseline.
