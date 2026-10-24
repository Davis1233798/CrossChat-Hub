// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights reserved.
// Derived from the BSD-licensed cefsimple sample; see CEF-LICENSE.txt.
// Official-store/pre-login experiment only. No account inspection or CDP.
#include "tests/cefsimple/simple_app.h"
#include <algorithm>
#include <iostream>
#include <vector>
#include "include/views/cef_box_layout.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_label_button.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_helpers.h"
#include "tests/cefsimple/simple_handler.h"

namespace {
constexpr char kStore[] = "https://chromewebstore.google.com/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc";
constexpr char kDetails[] = "chrome://extensions/?id=ophjlpahpchlmihnnnihgmmeilfjmjjc";
constexpr char kLine[] = "chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html";
class StoreClient : public SimpleHandler {
 public:
  StoreClient() : SimpleHandler(false) {}
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    SimpleHandler::OnAfterCreated(browser);
    browsers_.push_back(browser);
    std::clog << "{\"event\":\"prelogin-browser-created\"}" << std::endl;
  }
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    browsers_.erase(std::remove_if(browsers_.begin(), browsers_.end(),
        [&](const CefRefPtr<CefBrowser>& item) { return item->IsSame(browser); }), browsers_.end());
    SimpleHandler::OnBeforeClose(browser);
  }
  // Do not inherit the sample's failed-URL HTML injection or title copying.
  void OnTitleChange(CefRefPtr<CefBrowser>, const CefString&) override {}
  void OnLoadError(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame,
                   ErrorCode code, const CefString&, const CefString&) override {
    if (frame->IsMain()) std::clog << "{\"event\":\"prelogin-main-load-error\",\"code\":"
                                 << static_cast<int>(code) << "}" << std::endl;
  }
  bool TryCloseAll() {
    const auto snapshot = browsers_;
    bool ready = true;
    for (const auto& browser : snapshot)
      if (!browser->GetHost()->TryCloseBrowser()) ready = false;
    return ready;
  }
 private:
  std::vector<CefRefPtr<CefBrowser>> browsers_;
};
class StoreWindow : public CefWindowDelegate, public CefButtonDelegate {
 public:
  StoreWindow(CefRefPtr<CefBrowserView> view, CefRefPtr<StoreClient> client)
      : view_(view), client_(client) {}
  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    CefBoxLayoutSettings settings;
    settings.horizontal = false;
    auto layout = window->SetToBoxLayout(settings);
    auto store = CefLabelButton::CreateLabelButton(this, "Official LINE store");
    store->SetID(1);
    auto line = CefLabelButton::CreateLabelButton(this, "Open installed official LINE (pre-login only)");
    line->SetID(2);
    auto details = CefLabelButton::CreateLabelButton(this, "Official LINE extension details");
    details->SetID(3);
    window->AddChildView(store);
    window->AddChildView(details);
    window->AddChildView(line);
    window->AddChildView(view_);
    layout->SetFlexForView(view_, 1);
    window->SetTitle("CrossChat LINE official-store / pre-login experiment");
    window->Show();
  }
  void OnButtonPressed(CefRefPtr<CefButton> button) override {
    if (!view_ || !view_->GetBrowser()) return;
    // Fixed native destinations only; no script injection or install automation.
    view_->GetBrowser()->GetMainFrame()->LoadURL(button->GetID() == 2 ? kLine : button->GetID() == 3 ? kDetails : kStore);
  }
  bool CanClose(CefRefPtr<CefWindow>) override { return client_->TryCloseAll(); }
  void OnWindowDestroyed(CefRefPtr<CefWindow>) override { view_ = nullptr; client_ = nullptr; }
  CefSize GetPreferredSize(CefRefPtr<CefView>) override { return CefSize(1000, 760); }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
 private:
  CefRefPtr<CefBrowserView> view_;
  CefRefPtr<StoreClient> client_;
  IMPLEMENT_REFCOUNTING(StoreWindow);
};
class StoreView : public CefBrowserViewDelegate {
 public:
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
 private:
  IMPLEMENT_REFCOUNTING(StoreView);
};
}
SimpleApp::SimpleApp() = default;
void SimpleApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  CefRefPtr<StoreClient> client = new StoreClient();
  CefBrowserSettings settings;
  auto view = CefBrowserView::CreateBrowserView(client, kStore, settings,
                                               nullptr, nullptr, new StoreView());
  CefWindow::CreateTopLevelWindow(new StoreWindow(view, client));
}
CefRefPtr<CefClient> SimpleApp::GetDefaultClient() { return SimpleHandler::GetInstance(); }
