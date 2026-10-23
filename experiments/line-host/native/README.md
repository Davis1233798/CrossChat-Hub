# Same-window Views overlay (experimental)

`simple_app.cc` replaces the pinned upstream cefsimple sample's file with that
name. It reuses upstream SimpleApp/SimpleHandler and the sandbox-enabled Windows
bootstrap, rather than implementing a second executable bootstrap. See the parent
README for the exact upstream revision, CEF distribution, build and isolation
requirements. The adjacent CEF license covers the derived sample portions.

Copy this source into `<CEF_ROOT>/tests/cefsimple/simple_app.cc`, then rebuild the
existing upstream `cefsimple` target with VS2022 x64 Release. Keep the previously
documented mandatory `--crosschat-profile` guard in the Windows entrypoint. This
is a source overlay, not a standalone CMake project or a production application.
The ignored local copy was compiled on 2026-10-23 with sandbox enabled; compilation
and linking succeeded, with upstream unused delay-load linker warnings.

The browser always starts at our own synthetic fixture URL. Ordinary popup Views
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
Extension registration/readiness is still handled manually as described by the
baseline README. Multi-view close lifecycle and popup restoration are unverified.
Do not use this host for account login or real messages. It has not been launched
or visually verified, does not implement tabs, and is excluded from packaging.

The prior isolated host launch was rejected by automatic approval review
(`blocked by policy`, no more specific reason). No alternative execution method
was used to bypass that rejection. Runtime verification remains pending.
