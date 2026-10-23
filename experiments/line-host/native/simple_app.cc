// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights reserved.
// Portions derived from tests/cefsimple/simple_app.cc, BSD licensed (CEF LICENSE).
// CrossChat changes: synthetic-only same-window popup diagnostic, not LINE support.
#include "tests/cefsimple/simple_app.h"
#include <iostream>
#include <algorithm>
#include <vector>
#include "include/cef_command_line.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_fill_layout.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_helpers.h"
#include "tests/cefsimple/simple_handler.h"

namespace {
constexpr char kProbe[] = "chrome-extension://hcmjeeijoifmcgjhocekmfmepgijdjgb/probe.html";
class HostClient : public SimpleHandler {
 public:
  HostClient() : SimpleHandler(false) {}
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    SimpleHandler::OnAfterCreated(browser);
    browsers_.push_back(browser);
  }
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    browsers_.erase(std::remove_if(browsers_.begin(), browsers_.end(),
        [&](const CefRefPtr<CefBrowser>& item) { return item->IsSame(browser); }),
        browsers_.end());
    SimpleHandler::OnBeforeClose(browser);
  }
  bool TryCloseAll() {
    CEF_REQUIRE_UI_THREAD();
    // Do not short-circuit: every child must receive the graceful-close request,
    // including a worker-created top-level browser that escaped our Views.
    const auto snapshot = browsers_;
    bool ready = true;
    for (const auto& browser : snapshot) {
      if (!browser->GetHost()->TryCloseBrowser()) ready = false;
    }
    return ready;
  }
 private:
  std::vector<CefRefPtr<CefBrowser>> browsers_;
};
class HostWindow : public CefWindowDelegate {
 public:
  HostWindow(CefRefPtr<CefBrowserView> view, CefRefPtr<HostClient> client)
      : view_(view), client_(client) {}
  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->SetToFillLayout();
    window->AddChildView(view_);
    window->SetTitle("CrossChat synthetic host experiment");
    window->Show();
  }
  bool CanClose(CefRefPtr<CefWindow>) override {
    return client_->TryCloseAll();
  }
  void OnWindowDestroyed(CefRefPtr<CefWindow>) override { view_ = nullptr; }
  CefSize GetPreferredSize(CefRefPtr<CefView>) override { return CefSize(1000, 700); }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
 private:
  CefRefPtr<CefBrowserView> view_;
  CefRefPtr<HostClient> client_;
  IMPLEMENT_REFCOUNTING(HostWindow);
};
class EmbeddedPopup : public CefBrowserViewDelegate {
 public:
  bool OnPopupBrowserViewCreated(CefRefPtr<CefBrowserView> opener,
                                CefRefPtr<CefBrowserView> popup,
                                bool is_devtools) override {
    CEF_REQUIRE_UI_THREAD();
    auto window = opener->GetWindow();
    if (is_devtools || !window) {
      if (auto browser = popup->GetBrowser()) browser->GetHost()->CloseBrowser(true);
      return true;
    }
    // Fill layout gives both views the same bounds; show the popup above opener.
    // Closing the popup should expose opener. This is deliberately not tab UX.
    window->AddChildView(popup);
    window->Layout();
    popup->RequestFocus();
    std::clog << "{\"event\":\"popup-attached\",\"sameViewsWindow\":"
              << (popup->GetWindow() == window ? "true" : "false")
              << ",\"devtools\":false}" << std::endl;
    return true;
  }
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
 private:
  IMPLEMENT_REFCOUNTING(EmbeddedPopup);
};
}
SimpleApp::SimpleApp() = default;
void SimpleApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  CefRefPtr<HostClient> handler = new HostClient();
  CefBrowserSettings settings;
  auto view = CefBrowserView::CreateBrowserView(handler, kProbe, settings,
                                               nullptr, nullptr, new EmbeddedPopup());
  CefWindow::CreateTopLevelWindow(new HostWindow(view, handler));
}
CefRefPtr<CefClient> SimpleApp::GetDefaultClient() {
  // Worker-created windows may bypass the popup Views callback entirely.
  // Merely assigning the client does not establish same-window hosting.
  return SimpleHandler::GetInstance();
}
