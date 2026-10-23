// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights reserved.
// Portions derived from tests/cefsimple/simple_app.cc, BSD licensed (CEF LICENSE).
// CrossChat changes: synthetic-only same-window popup diagnostic, not LINE support.
#include "tests/cefsimple/simple_app.h"
#include <iostream>
#include <algorithm>
#include <limits>
#include <vector>
#include <set>
#include "include/cef_devtools_message_observer.h"
#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/cef_command_line.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_fill_layout.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_helpers.h"
#include "tests/cefsimple/simple_handler.h"

namespace {
constexpr char kProbe[] = "chrome-extension://hcmjeeijoifmcgjhocekmfmepgijdjgb/probe.html";
constexpr char kOrigin[] = "chrome-extension://hcmjeeijoifmcgjhocekmfmepgijdjgb";
constexpr char kWorker[] = "chrome-extension://hcmjeeijoifmcgjhocekmfmepgijdjgb/worker.js";
// Internal DevTools transport only: no diagnostic TCP listener is required.
class FixtureReadiness : public CefDevToolsMessageObserver, public CefTask {
 public:
  explicit FixtureReadiness(CefRefPtr<CefBrowser> browser) : browser_(browser) {}
  void Start() {
    auto params = CefDictionaryValue::Create();
    params->SetBool("discover", true);
    if (!Call(1, "Runtime.enable", nullptr) ||
        !Call(2, "Target.setDiscoverTargets", params) ||
        !Call(3, "Target.getTargets", nullptr)) Fail("dispatch-failed");
    if (!CefPostDelayedTask(TID_UI, this, 30000)) Fail("timer-failed");
  }
  void Stop() { browser_ = nullptr; done_ = true; contexts_.clear(); }
  void Execute() override { if (!done_) Fail("timeout"); }
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>, int id, bool success,
                             const void* result, size_t size) override {
    if (done_) return;
    if (!success) { Fail("protocol-method-failed"); return; }
    if (id != 3) return;
    auto dict = Parse(result, size);
    auto targets = dict ? dict->GetList("targetInfos") : nullptr;
    if (targets) for (size_t i = 0; i < targets->GetSize(); ++i)
      CheckWorker(targets->GetDictionary(i));
  }
  void OnDevToolsEvent(CefRefPtr<CefBrowser>, const CefString& method,
                       const void* params, size_t size) override {
    if (done_) return;
    auto dict = Parse(params, size);
    if (!dict) return;
    if (method == "Target.targetCreated" || method == "Target.targetInfoChanged") {
      CheckWorker(dict->GetDictionary("targetInfo"));
    } else if (method == "Runtime.executionContextsCleared") {
      contexts_.clear();
    } else if (method == "Runtime.executionContextDestroyed") {
      contexts_.erase(dict->GetInt("executionContextId"));
    } else if (method == "Runtime.executionContextCreated") {
      auto context = dict->GetDictionary("context");
      auto aux = context ? context->GetDictionary("auxData") : nullptr;
      if (context && aux && aux->GetBool("isDefault") &&
          context->GetString("origin") == kOrigin)
        contexts_.insert(context->GetInt("id"));
    } else if (method == "Runtime.consoleAPICalled" && navigated_ &&
               contexts_.count(dict->GetInt("executionContextId")) &&
               browser_ && browser_->GetMainFrame()->GetURL() == kProbe) {
      auto args = dict->GetList("args");
      auto first = args && args->GetSize() == 1 ? args->GetDictionary(0) : nullptr;
      if (!first || first->GetString("type") != "string") return;
      const std::string value = first->GetString("value");
      auto data = Parse(value.data(), value.size());
      if (!data || data->GetString("event") != "crosschat-fixture-ready") return;
      auto caps = data->GetDictionary("capabilities");
      if (data->GetInt("starts") < 1 || !caps || !caps->GetBool("worker")) {
        Fail("invalid-handshake"); return;
      }
      for (const char* key : {"worker", "windowsCreate", "windowsRemoved", "downloads",
                              "notifications", "cookies", "display"}) {
        if (caps->GetType(key) != VTYPE_BOOL) { Fail("invalid-capabilities"); return; }
      }
      done_ = true;
      std::clog << "{\"event\":\"fixture-readiness\",\"ready\":true}" << std::endl;
      browser_ = nullptr;
    }
  }
  void OnDevToolsAgentDetached(CefRefPtr<CefBrowser>) override {
    if (!done_) Fail("agent-detached");
  }
 private:
  static CefRefPtr<CefDictionaryValue> Parse(const void* bytes, size_t size) {
    if (!bytes || !size) return nullptr;
    auto value = CefParseJSON(bytes, size, JSON_PARSER_RFC);
    return value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
  }
  bool Call(int id, const char* method, CefRefPtr<CefDictionaryValue> params) {
    return browser_ && browser_->GetHost()->ExecuteDevToolsMethod(id, method, params) != 0;
  }
  void CheckWorker(CefRefPtr<CefDictionaryValue> target) {
    if (!done_ && !navigated_ && target &&
        target->GetString("type") == "service_worker" && target->GetString("url") == kWorker) {
      navigated_ = true;
      browser_->GetMainFrame()->LoadURL(kProbe);
    }
  }
  void Fail(const char* reason) {
    if (done_) return;
    done_ = true;
    std::clog << "{\"event\":\"fixture-readiness\",\"ready\":false,\"reason\":\""
              << reason << "\"}" << std::endl;
    browser_ = nullptr;
  }
  CefRefPtr<CefBrowser> browser_;
  std::set<int> contexts_;
  bool done_ = false;
  bool navigated_ = false;
  IMPLEMENT_REFCOUNTING(FixtureReadiness);
};
class HostClient : public SimpleHandler {
 public:
  HostClient() : SimpleHandler(false) {}
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    SimpleHandler::OnAfterCreated(browser);
    browsers_.push_back(browser);
    if (readiness_browser_id_ == -1) {
      readiness_browser_id_ = browser->GetIdentifier();
      readiness_ = new FixtureReadiness(browser);
      registration_ = browser->GetHost()->AddDevToolsMessageObserver(readiness_);
      readiness_->Start();
    }
  }
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    if (browser->GetIdentifier() == readiness_browser_id_) {
      readiness_->Stop();
      registration_ = nullptr;
      readiness_ = nullptr;
    }
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
  CefRefPtr<FixtureReadiness> readiness_;
  CefRefPtr<CefRegistration> registration_;
  int readiness_browser_id_ = -1;
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
  void OnBrowserDestroyed(CefRefPtr<CefBrowserView> view,
                          CefRefPtr<CefBrowser>) override {
    CEF_REQUIRE_UI_THREAD();
    const auto item = std::find_if(popups_.begin(), popups_.end(),
        [&](const AttachedPopup& popup) { return popup.view == view; });
    if (item == popups_.end()) return;
    // The upstream lifespan handler only tracks browsers. An empty overlay
    // must also leave the Views hierarchy or it can obscure the opener.
    auto window = item->window;
    popups_.erase(item);
    if (!window || !window->IsValid()) return;
    if (view->IsValid() && view->GetParentView() == window) {
      window->RemoveChildView(view);
    }
    window->Layout();
    // The opener may itself have closed. Restore the uppermost live view,
    // rather than retaining an opener reference that outlives its browser.
    for (size_t count = window->GetChildViewCount(); count > 0; --count) {
      if (count - 1 > static_cast<size_t>(std::numeric_limits<int>::max())) return;
      auto remaining = window->GetChildViewAt(static_cast<int>(count - 1))->AsBrowserView();
      if (remaining && remaining->GetBrowser()) {
        remaining->RequestFocus();
        break;
      }
    }
  }
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
    popups_.push_back({popup, window});
    window->Layout();
    popup->RequestFocus();
    std::clog << "{\"event\":\"popup-attached\",\"sameViewsWindow\":"
              << (popup->GetWindow() == window ? "true" : "false")
              << ",\"devtools\":false}" << std::endl;
    return true;
  }
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
 private:
  struct AttachedPopup {
    CefRefPtr<CefBrowserView> view;
    CefRefPtr<CefWindow> window;
  };
  std::vector<AttachedPopup> popups_;
  IMPLEMENT_REFCOUNTING(EmbeddedPopup);
};
}
SimpleApp::SimpleApp() = default;
void SimpleApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  CefRefPtr<HostClient> handler = new HostClient();
  CefBrowserSettings settings;
  auto view = CefBrowserView::CreateBrowserView(handler, "about:blank", settings,
                                               nullptr, nullptr, new EmbeddedPopup());
  CefWindow::CreateTopLevelWindow(new HostWindow(view, handler));
}
CefRefPtr<CefClient> SimpleApp::GetDefaultClient() {
  // Worker-created windows may bypass the popup Views callback entirely.
  // Merely assigning the client does not establish same-window hosting.
  return SimpleHandler::GetInstance();
}
