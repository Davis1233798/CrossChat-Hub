# Official LINE store / pre-login host (build-only experiment)

This independent source, `line_store_app.cc`, replaces the scratch upstream
`simple_app.cc` only when `build.ps1 -AppMode line-prelogin` is selected. The
repository's synthetic source remains intact. Use the prerequisites and pinned
checkout in [README.md](README.md), with the same build arguments and this mode.
The final executable at a reused build path represents the last selected mode;
never assume it is synthetic merely from its `cefsimple.exe` filename.

This mode starts the main Chrome-style BrowserView at only the exact official
LINE Chrome Web Store listing. Three native buttons return to that listing, open the fixed official-ID
extension-details page, or navigate the existing BrowserView to the official
extension ID's `index.html`.
There is no arbitrary start-URL argument, JavaScript injection, fake install
response, manifest change, or authentication/protocol replacement. Installing
from the normal official store UI remains a separate manual verification step.
The button does not install LINE or prove the extension is present.

The shared entrypoint retains sandbox bootstrap, certificate checks and atomic
fresh temporary-profile creation. CMake compiles this mode with
`CROSSCHAT_LINE_PRELOGIN=1`; the entrypoint then rejects
`--crosschat-diagnostics`, `--load-extension` and `--disable-extensions-except`
before creating a profile. Existing remote-debugging switches are also rejected.
Unlike the synthetic source this source uses no DevTools transport, worker
inspection or content evaluation. Its callbacks log only browser creation and
main-frame error codes; titles and failed URLs are not copied to logs or HTML.
No account, QR or message extraction is implemented.

This is a pre-login compatibility artifact. Do not enter credentials or scan a
QR in it. Once execution is available, first inspect the real listing and native
permission dialog, complete a normal signed store install, verify official ID
`ophjlpahpchlmihnnnihgmmeilfjmjjc` using the official extensions UI, and use the
native button to check original startup in the existing window. Do not invoke
private store JavaScript APIs or bypass install/signature/permission decisions.
Store UI may need Chrome components or dialog parenting that this artifact has
not yet demonstrated. Extension-created worker windows may still escape into
other native windows; no same-window claim follows from this mode's existence.

Fresh-only profiles cannot prove persistent account sessions. A later production
profile design and manual account acceptance are separate required work. The
pinned CEF 144 build is an older compatibility baseline, not a current security
release. This mode is excluded from application packaging. No executable launch,
store install, LINE login or visual verification is performed by the build script.

Build verification on 2026-10-23: Windows x64 Release configured, compiled and
linked for `line-prelogin`, then for `synthetic`, using VS2022 MSVC 19.44 and
SDK 10.0.26100.0. The generated `cefsimple.vcxproj` contained
`CROSSCHAT_LINE_PRELOGIN=1` for the first build and omitted it for the second.
The CMake hook applies this definition to cefsimple only and preserves toolchain
flags. The final shared scratch output is synthetic. Upstream ATL-unavailable
and unused delay-load warnings remain. No executable was launched.
