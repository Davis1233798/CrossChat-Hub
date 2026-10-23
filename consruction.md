# CrossChat Hub — Codex 開發交接與施工規格（consruction.md）

> **2026-10-23 接手開發補充：** 使用者已確認第五個服務沿用 WhatsApp。已在 `codex/messenger-development` 補強導航／redirect／遞迴彈窗限制、快捷鍵頁籤狀態同步、Electron 真實視窗 smoke、依賴鎖定及現行架構文件。本機 35 項測試、Windows MSI/NSIS/ZIP 打包與打包後視窗啟動／正常退出通過；未驗證安裝升級或真人聊天。完整分項證據見 `docs/acceptance.md`。下文原始交接現況保留作歷史基準，LINE 與真人 E2E 仍是正式發行阻礙。

> 更新日期：2026-10-23（Asia/Taipei）  
> 專案：https://github.com/Davis1233798/CrossChat-Hub  
> **本檔刻意採用使用者指定檔名 `consruction.md`（不是 `construction.md`）。**  
> **用途：** 接手開發的 Codex 請先完整閱讀本檔，再閱讀當前分支的 README、程式碼及 GitHub Actions；以驗收結果而不是 UI 是否存在判定完成。

## 0. 最重要的需求與工作原則

這是 **Windows / macOS「多通訊軟體桌面客戶端」**，不是讓一般使用者設定 Bot Token、Webhook Secret、開發者 OAuth Client Secret 或手動貼上使用者 ID 的管理系統。

使用者要的最終體驗：

1. **只從 GitHub 最新 Release 下載安裝包，直接安裝／更新／啟動**，不必執行 PowerShell、修復腳本、終端機命令，也不必開啟管理員模式才能正常使用。
2. 在 **同一個 CrossChat Hub 桌面視窗**中，以 **5 個 Tab** 切換聊天軟體；每個 Tab 要能以真正的個人帳號登入並完成其平台允許的聊天操作，重新開啟後保留登入狀態、支援登出。
3. 已明確提到的服務有 **LINE、Telegram、Discord、Slack**。目前開發分支把 **WhatsApp 當成暫定第五種**；使用者尚未明確指定第五種，**Codex 應確認這個假設，但不要因此中斷其他能執行的工作**。
4. 在某平台的聊天情境中使用 `@platform:alias` 標記其他平台的人，目標是讓對方**真的收到**符合授權與平台規範的通知／訊息。純文字替換、UI 提示、本機模擬或把另一平台的名字顯示出來，都**不是**完整的跨平台通知。
5. 一般使用者不應看到「連線名稱、Bot Token、Webhook Secret、建立跨平台身分對應」作為初次使用的必要步驟。這些舊功能可以保留為進階管理員工具，但不得擋住一般登入流程。
6. **不得宣稱沒有驗證過的功能已可使用**。CI 單元測試 ≠ 真的能登入。成功產生 EXE／MSI／DMG ≠ 真正能安裝更新或通訊。若 LINE 或其他平台在法規、官方能力或技術上無法滿足此要求，請明確標示阻礙與替代方案，不要做假的五平台 Release。

### 最終可交付標準（Definition of Done）

只有以下條件全部滿足，才可宣稱完成使用者要求的正式 Release：

- Windows 11 **乾淨安裝、從前一版升級、解除安裝、正常結束、重開、重新登入**的端對端測試通過；沒有 EXE 被鎖住、背景程序無法退出、或必須手動修復的情形。支援 MSI 與 NSIS EXE 時，兩者的升級／互斥／移除規則必須明確且已驗證。
- macOS **Intel x64 與 Apple Silicon arm64** 的 DMG 均實機或合適虛擬環境驗證可安裝、啟動、退出、重開與更新；僅檢查 DMG 是否能掛載不足以當作完整驗收。
- 5 個 Tab 內每個平台都完成：**真實使用者登入 → 查看真實聊天室 → 發送與接收訊息 → 登出 → 重開後狀態確認**。有平台僅能開外部程式，就不符合「都包在同一個視窗內」的原始要求，必須明示並取得需求變更授權。
- `@platform:alias` 能在至少一對已獲使用者授權、具備官方可用傳訊 API 的平台間完成**真實端對端**通知、去重、錯誤處理、同意／撤銷。不能保證支援的平台應標示不支援，不要使用未授權自動化普通帳號。
- 不須每位使用者自己申請開發者金鑰，不向使用者索取服務密碼，不需自行執行腳本；維護者需要的一次性應用程式註冊／憑證，由產品打包或安全授權服務負責。
- 發行檔案可從同一 GitHub Release 取得，並有對應版本的測試證據、已知限制及安全公告。正式發佈應安排 Windows 簽章、macOS 簽章與 notarization；未完成時不得宣稱商用可信任安裝體驗。

## 1. 儲存庫現況：**先分清 main 與開發分支**

| 項目 | 實際情況（2026-10-23 已核對 GitHub） |
|---|---|
| Repository | `Davis1233798/CrossChat-Hub`，public |
| `main` HEAD | `57e61f9dd70a86fa3b5f95add2b715d379e87940`；v0.3.1 時期的桌面／本機 API／示範版 |
| 開發分支 | `feature/messenger-tabs-experimental` |
| 開發分支 HEAD | `bf38d27b15865d8010655a71e53e0bfc6e28926f`；五 Tab 分頁容器、Windows NSIS 升級與 CI smoke-test |
| `package.json`（開發分支） | `0.4.0-dev.1`，**不是已發布版本** |
| GitHub 最新已發布 Release | `v0.3.1`（**unsigned prerelease**），沒有包含後續五 Tab 分支 |
| 最近開發分支 Actions | `39945076079`：CI、Windows x64、macOS Intel、macOS ARM、Windows NSIS 安裝／啟動／關閉 smoke-test 全部成功；release job **skipped**（不應自動發布開發版） |
| 測試覆蓋 | 開發分支最後回報 **32 項自動化測試**；多數為本機、mock、靜態程式碼或安裝 smoke-test；**無五平台真人登入驗證** |

參考連結：

- [開發分支](https://github.com/Davis1233798/CrossChat-Hub/tree/feature/messenger-tabs-experimental)
- [開發分支最新 Commit](https://github.com/Davis1233798/CrossChat-Hub/commit/bf38d27b15865d8010655a71e53e0bfc6e28926f)
- [已通過的跨平台建置與安裝煙霧測試](https://github.com/Davis1233798/CrossChat-Hub/actions/runs/39945076079)
- [現有 Releases](https://github.com/Davis1233798/CrossChat-Hub/releases)

**Codex 建議：** 先從 `feature/messenger-tabs-experimental` 接續開發；合併回 `main` 需經 PR、代碼檢查和必要 E2E 驗收。不要以 `main` README 誤認目前分頁版已在 Latest Release。避免直接 force-push 或覆蓋歷史。

## 2. 發展歷史、已做功能與真正的驗證等級

| 時期 | 程式中已實作的內容 | 狀態與限制 |
|---|---|---|
| v0.1 初版 | Node.js HTTP 服務、SQLite、Slack／Discord／Telegram／LINE **Bot/官方帳號** Adapter；Webhook 簽章檢查、Token 加密、去重、Outbox、`@platform:alias`、人工身分 mapping | **Bot 管理中台**，不是個人聊天客戶端；測試是 mock/API 層，沒有五個私人帳號登入 |
| v0.2 | Electron desktop、Slack OAuth、Discord OAuth identify、Discord Gateway 收訊／心跳／重連、單向／雙向聊天室文字橋接與管理 UI | Bridge 是有權限的 Bot/Channel 訊息轉送；不是個人聊天原生互通或跨平台原生 mention |
| v0.2.1 | Windows x64 MSI、NSIS EXE；macOS x64/arm64 DMG/ZIP；GitHub Actions + prerelease | 曾有 MSI WiX 缺少 icon 及 manufacturer 等問題，修正後可產出安裝檔；當時只驗證打包 |
| v0.3 | 帳號登入優先首頁、Slack 使用者 OAuth 下的部分聊天室 API、Discord/LINE OAuth 身分驗證 | Slack 需開發者註冊／scope；Discord/LINE **OAuth 登入只證明身分，不等於可存取私人聊天**；真實 E2E 未完成 |
| v0.3.1 | 離線示範聊天室、Telegram MTProto（`teleproto`）電話／驗證碼／2FA、訊息列表與傳送程式；關閉流程加入逾時防護 | Demo **僅本機**；Telegram 需維護者提供 `api_id/api_hash`，僅有模擬傳輸測試，**無真人完整 E2E**；已發布 unsigned prerelease |
| v0.4 開發分支 | Electron `WebContentsView` 五 Tab；Telegram/Discord/Slack/WhatsApp 官網網頁載入；平台隔離 `persist:` session、分頁記憶、附件下載、媒體權限、未讀標題；LINE 顯示官方外部途徑；NSIS 結束舊程序；Windows 安裝 smoke-test | **只有四個嵌入式官方網頁介面；LINE 並未真正嵌入。** 四平台網頁版真人登入、保留 Session、收發訊息尚未人工驗證；沒有將 `@mention` 真正整合到網頁分頁；未發布為 Release |

注意「在 Tab 中載入官方登入頁面」不是「登入功能驗收成功」；「持久化 Cookie session 已配置」不是「跨平台登入後一定保留登入」；「CI 安裝器測試通過」不涵蓋使用者現有裝置上的舊版殘留程序／企業防毒軟體／SmartScreen。

## 3. 當前五平台能力與不可偷換的概念

| 平台 | v0.4 開發分支做法 | 已驗證程度 | 核心問題／Codex 下一步 |
|---|---|---|---|
| Telegram | `https://web.telegram.org/k/`，持久 session；另有舊版 MTProto 實作 | 網頁 Tab 建立／本機測試；真人登入、發訊未驗證 | 選擇並實測 web 客戶端或正式 MTProto 原生介面；確認電話、QR、2FA、登入保留、登出；不要求一般使用者自行填 API ID |
| Discord | `https://discord.com/app` | 網頁 Tab 建立，登入未驗證 | 以官方網站操作人工驗證登入／聊天；**Discord OAuth identify 不能用來自動讀寫私人聊天，禁止 self-bot** |
| Slack | `https://slack.com/signin` | 網頁 Tab 建立，登入未驗證 | 實測工作區 SSO、郵件登入、登入彈窗、瀏覽器相容性與訊息讀寫；既有使用者 OAuth API 路線可視需求選用 |
| WhatsApp（暫定第五種） | `https://web.whatsapp.com/` | 網頁 Tab 建立，掃碼／連結裝置未驗證 | 確認第五種平台是否確為 WhatsApp，驗證 QR 登入、連結裝置、重啟後 Session 與基本聊天；不可私自使用未授權協定 |
| LINE | 無官方一般網頁聊天室；目前只顯示官網／Chrome 擴充功能連結 | **無內嵌登入、私人訊息收發能力** | **P0 阻礙**。官方 Windows/macOS App 和 Chrome 擴充功能不是可隨意封裝的 WebView 網站；必須研究合法授權、相容性及可維護的產品方案。沒有解法就不能聲稱滿足五平台同窗登入 |

**官方限制／實作依據（交接時需重新確認最新政策）：**

- LINE 官方 PC 說明：https://help2.line.me/line/smartphone?contentId=50001182&lang=zh-Hant
- LINE Login 主要提供使用者身分／profile：https://developers.line.biz/en/docs/line-login/managing-users/
- LINE Messaging API 針對 LINE Official Account：https://developers.line.biz/en/docs/messaging-api/overview/
- Electron 明確不支援任意 Chrome Web Store 擴充功能：https://www.electronjs.org/docs/latest/api/extensions/
- Telegram 第三方客戶端需要自己申請 `api_id/api_hash`：https://core.telegram.org/api/obtaining_api_id
- Telegram API 合約與操作限制：https://core.telegram.org/api/terms
- Discord 禁止 self-bot：https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots
- Slack 登入途徑／SSO：https://slack.com/help/articles/212681477-Sign-in-to-Slack

**不要**透過讀取使用者密碼、擷取 Cookie、注入非官方 client、繞過登入／平台政策，或未授權重打包 LINE/其他公司的程式來假裝解決障礙。若功能需要平台商授權，提出需要的授權／合作條件和實際上線替代設計。

## 4. 主要程式碼導覽（以開發分支為準）

| 路徑 | 角色／應注意事項 |
|---|---|
| `desktop/main.cjs` | 新桌面容器進入點；單實例鎖、視窗、`WebContentsView` Tab、session、popup、視窗導航、下載、權限、退出。**v0.4 桌面不是透過舊 `src/runtime.mjs` 的 HTTP Server 啟動** |
| `desktop/tab-config.cjs` | 五平台 ID／入口 URL／`persist:crosschat-*` 分區。**LINE `kind: 'unsupported-extension'`，`url: null`** |
| `desktop/permissions.cjs` | 官方網域判斷、media/notifications 權限；安全邊界需進一步審查 |
| `desktop/shell.html`, `shell.css`, `shell.js` | Tab UI、切換、上次 Tab、狀態與外部官方網頁 fallback |
| `desktop/preload.cjs` | 窄範圍 IPC Bridge；不得把 Node/FileSystem API 暴露給外部聊天網站 |
| `build/windows-installer.nsh` | NSIS `customInit` / `customUnInit` 用 `ExecWait` 執行 `taskkill`，用來避免安裝時 EXE 被鎖住。**強制終止可能影響使用者資料，仍需更優雅的升級策略** |
| `package.json` | Electron/electron-builder、MSI/NSIS/DMG/ZIP、版本、圖示、依賴與 npm scripts |
| `.github/workflows/desktop-build.yml` | 測試矩陣、Win 安裝／啟動／關閉 smoke、Mac DMG 掛載測試；**只有推 `v*` tag 才發布 Release** |
| `.github/workflows/ci.yml` | `npm run check`、`npm test`（Node 22）；desktop build 用 Node 24，需評估統一版本 |
| `test/desktop-tabs.test.mjs`, `desktop-security.test.mjs` | Tab 與靜態安全設定測試；**不是登入驗收** |
| `src/telegram-user.mjs` | `teleproto` MTProto；程式實作並有 mock 測試，真人登入未驗證；session 屬敏感憑證 |
| `src/demo.mjs` | **離線演示**，`@line:alice` 僅本機模擬，不是真實通知 |
| `src/app.mjs`, `src/oauth.mjs`, `src/bridge.mjs`, `src/gateway.mjs`, `src/store.mjs` | 舊 Bot/OAuth/Gateway/Bridge 後端；不能直接假設適用於五個個人聊天 Tab |
| `docs/architecture.md`, `docs/desktop.md`, `docs/roadmap.md` | 多為 v0.2～v0.3 歷史內容，**部分過時**（如自動 release 觸發條件與桌面主入口）；Codex 改完架構需一併更新 |
| `scripts/repair-windows.ps1` | 舊版問題診斷／修復用；**使用者明確拒絕被要求執行這類腳本**；不能當作正常產品使用／更新流程 |

開發指令（**僅 Codex／開發者**執行，不提供給終端使用者）：

```bash
npm install
npm run check
npm test
npm run desktop
npm run desktop:win         # Windows 建置環境
npm run desktop:mac         # macOS 建置環境
```

## 5. 已遇問題、根因、修正歷史與殘餘風險

### 5.1 使用者無法安裝，提示 `Error writing to file` / 無法覆寫 EXE

- Windows 畫面顯示安裝器無法寫入 `%LOCALAPPDATA%\Programs\CrossChat Hub\CrossChat Hub.exe`，也曾反映透過系統無法結束程序、管理員模式同樣不能正常使用。
- 舊 v0.3 入口 `desktop/main.cjs` 在 `before-quit` 等候 `http.Server.close()`，**沒有逾時**；持續連線可能阻止程序結束，導致 EXE 被鎖定。
- v0.3.1 加入 2.5 秒限時與強制退出；v0.4 更改架構，桌面主視窗不再啟動舊 HTTP Server；加上 Windows NSIS 的升級前結束舊程序功能。
- **尚未涵蓋：** 用戶機上由 v0.3 MSI 升級 v0.4 NSIS、MSI 與 NSIS 混用、Windows Installer 已有登錄資訊、背景殘留程序、強制關閉造成未存資料，以及受控電腦的權限／防毒限制。Windows 現有 smoke-test 是**乾淨環境的 NSIS 靜默安裝／啟動／關閉**，沒有驗證 MSI 原地升級或真實舊版本遷移。
- 使用者要求：**不能把安裝／修復腳本交給使用者操作**；必須在安裝程式與產品生命週期中自動解決並提供清楚、非技術性的錯誤提示。

### 5.2 WiX MSI 建置曾失敗

- 早期 `v0.2.1` 建置曾報 `LGHT0094: Icon:CrossChatHubIcon.exe could not be found`，並提示 MSI manufacturer 未設定。
- 已加入 `build/icon.ico`、`build/icon.png`、`author` 等，後續產出 x64 MSI／EXE；這不代表 MSI 在所有升級情境都能安裝成功。
- Codex 應加上 MSI **實際安裝／解除安裝／版本升級**測試，不能只檢查副檔名存在。

### 5.3 新增安裝器 hook 後 Windows smoke-test `0xC0000005`

- 失敗 Actions：[`39944253379`](https://github.com/Davis1233798/CrossChat-Hub/actions/runs/39944253379)。Windows NSIS `/S` 退出碼 `-1073741819`（即 `0xC0000005` 存取違規）。
- 首次使用 NSIS `nsExec` 執行 `taskkill` 的自訂初始化流程；之後改 `ExecWait`，commit [`bf38d27`](https://github.com/Davis1233798/CrossChat-Hub/commit/bf38d27b15865d8010655a71e53e0bfc6e28926f)。
- 成功 Actions：[`39945076079`](https://github.com/Davis1233798/CrossChat-Hub/actions/runs/39945076079)：Windows 靜默安裝、找出 EXE、啟動視窗、發出 `WM_CLOSE`、確認退出；Mac 雙架構 DMG 掛載檢查成功。
- **注意：** 不能據此宣稱全部安裝器、所有舊版本升級、真人登入都已成功。

### 5.4 曾把假登入／只有介面的功能寫成「登入完成」

- 首頁一度顯示 Telegram／LINE／Discord／Slack 登入按鈕，實際需要使用者去配置 OAuth app credentials、callback 或機器人參數。
- Discord／LINE 的 OAuth 可以驗證個人身分，但**不等於取得私人聊天讀寫權**。Telegram Bot 不等於個人帳號。離線 demo 不是真實聊天服務。
- 改用 v0.4 分頁容器是為了降低首次使用門檻：以官方網頁自身的登入流程而非讓使用者填 Bot Token。但目前四個網站還沒做真人 E2E，LINE 無法網頁嵌入。
- Codex 禁止以「按鈕可點」「網頁成功載入」「有 OAuth token」「本機模擬成功」宣稱真實登入與傳訊完成。

### 5.5 GitHub Release 曾不存在／使用者只能看到 1 Tag

- 早期 workflow 僅上傳 Actions Artifact，未執行 GitHub Release 建立步驟，或沒有推送觸發用的版號 tag；另曾因 CI `test/bridge.test.mjs` 上傳被截斷（最後 142 bytes），造成 `SyntaxError: missing ) after argument list` 而失敗。
- 後來建好 Releases `v0.2.1`、`v0.3.0`、`v0.3.1`，均為 unsigned prerelease，含 Windows MSI/EXE/ZIP、macOS Intel DMG/ZIP、ARM64 DMG/ZIP。GitHub 首頁不一定將 prerelease 顯示為 latest stable Release。
- **現有開發分支已改成只有 `v*` tag 才發布 Release**；每次 push feature/main 可產生 Actions Artifact，但**不應自動把實驗版當作給使用者的 Latest**。
- Codex 應要求成品的 Release 包含完整版本資訊、變更內容、限制、校驗值與與 tag 一致的原始碼；發行前檢查平台功能，而非僅檢查 3 個副檔名。

### 5.6 安全、法規與架構風險

- **LINE：** 沒有可直接以 Electron WebView 載入的官方個人網頁聊天室；LINE Login 與 Official Account Messaging API 都不等於一般個人 LINE 桌面版功能。Chrome 擴充功能受 Electron 兼容性／散佈授權限制。
- **Discord：** 不得 self-bot、自動化一般使用者帳號；嵌入官方網站供使用者手動聊天與程式自動讀寫 Discord 私訊是**兩種不同能力**。
- **WhatsApp／Slack：** QR、SSO、第三方瀏覽器支援與登入存活皆需真實人工驗證；外部瀏覽器登入不會自動把 Cookie 回填 Electron Session。
- **Electron：** `desktop/tab-config.cjs` 的 `safeNavigation()` 目前只限制 HTTPS，**不是完整的網域 allowlist**。OAuth popup 也可能使用非平台網域，必須在不破壞合法 SSO 的前提下審查 opener、IPC、session、下載、權限和外部連結。不得偷取 Cookie／密碼或注入第三方網站以操控其私人訊息。
- **資料：** Telegram session、Token、SQLite、聊天內容屬敏感資料。需加密／金鑰安全儲存、限定權限、明確保留和刪除政策；升級／移除程式時不得誤刪 Session。不能把 `.env`、SQLite、Token、真實通訊資料提交 GitHub。
- **通知：** Bot 橋接通常是至少一次發送；失敗重試可能重複。跨平台 private messaging 需要同意與合法 API；不可假扮原生 `@mention`。跨平台 alias 應採 opt-in 使用者綁定、撤銷、目的地確認、稽核紀錄與去重。

## 6. Codex 下一步執行清單（按優先順序）

### P0 — 先做產品可行性與可安裝性（阻擋正式發行）

1. **確認五個目標服務。** 已知四種 LINE／Telegram／Discord／Slack；WhatsApp 為暫定第五種。把最後決定寫入產品設定與測試清單，避免假設變需求。
2. **LINE 方案決策（最高風險）。** 研究截至執行時的官方方式與授權條件，提交技術／法律可行性矩陣。若沒有可合法同窗運行完整私人聊天的方案，標記為產品阻礙；不要用外部開啟、假的登入頁或非法非官方協定宣稱完成。
3. **四個官方網站真實登入 E2E。** Windows、macOS Intel/ARM 分別驗證 Telegram、Discord、Slack（含 SSO）、WhatsApp（含 QR）。至少含登入、聊天列表、真實送收、附件（如適用）、重啟保留 Session、登出；記錄不包含任何隱私或金鑰的測試證據。沒有真實測試帳號的部分一律保持「未驗證」。
4. **安裝與升級回歸。** Windows NSIS/ MSI 各做 clean install、已安裝舊版時原地升級、解除安裝、重啟、程序殘留檢查與兩種安裝器衝突策略。Mac 雙架構要有真正 `open`／關閉與升級測試，而非只有 `hdiutil attach`。必要時設計 single-instance 安全關閉 IPC，再保守 fallback 結束程序；不可無提示毀損未同步資料。
5. **桌面發行品質。** 評估 Windows Authenticode 簽章、macOS Developer ID／notarization、正確權限、版本管理、可追蹤安裝錯誤、完整卸載。使用者只會下載 Latest Release，不能要求執行腳本或開發指令。

### P1 — 真正的聊天整合與跨平台通知

6. 擇一明確架構：**(A) 官方網頁的人工互動工作區**（可切 Tab，但不保證能透過統一 API 讀寫跨平台個人私訊）；或 **(B) 經官方授權的統一訊息後端**（有權限的平台才做收送與跨平台路由）。兩者可共存，但 UI 必須明確區分；不要宣稱把任意網頁封裝起來就能跨平台標記。
7. 設計 `@platform:alias` 的**身分自主綁定與同意流程**，並只針對可合法送達的平台發通知；支援失敗回報、節流、去重、撤銷。證明至少一組真實平台的 E2E；其餘顯示限制。
8. 把 Bot／管理中台移到管理員進階區域，避免一般使用者看見 Secret 表單。若要允許多帳號／多工作區，需能獨立切換 session 並避免互相洩漏。
9. 加入每個 Tab 的登入狀態、權限不足、連線中斷、重新登入及未讀狀態，**不是只從頁面標題或頁面 loaded 事件推斷已登入**。

### P2 — 文件、維護與安全

10. 新增安裝／更新／登入／登出／敏感資料清除的 Playwright 或其他適合 Electron 的 E2E 測試（以實際平台政策為準），以及可審閱的手動驗收 checklist。
11. 審查 `WebContentsView` popup／導航／第三方 SSO、權限 handler、持久 session、程式碼簽章、AutoUpdate 與資料目錄；保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
12. 更新 `README.md`、`docs/architecture.md`、`docs/desktop.md`、`docs/roadmap.md`，刪除會誤導的舊版本說明與已過期發行規則。
13. 規劃可回溯 commit／PR，版本升級時保留 release notes，勿將模擬功能列成真實支援。

## 7. Codex 每輪交付格式與不可變規則

每個 PR／工作回覆請提供：

1. **變更的檔案、核心實作**與對應 Commit/PR；不要只有「已修復」的文字。
2. 執行過的 `npm run check`、`npm test`、Windows/macOS Build/Smoke/E2E 結果及 URL；測試不可執行時必須指出阻礙。
3. **平台矩陣：** 已實裝、mock 驗證、打包測試、真人登入、實際收送、重啟登入保留，六項分開標示。
4. **未解阻礙與風險：** 特別是 LINE 同窗支援、WhatsApp 是否為第五種、OAuth／SSO、跨平台 `@mention` 送達與用戶資料安全。
5. **發行判斷：** 如未通過全部必要驗收，只提交開發分支／PR，不建立假裝可用的正式 Latest Release；若符合則建立版號 tag、發布 Windows x64 MSI/EXE、macOS Intel/ARM64 DMG，驗證所有 GitHub Release assets 存在。

**使用者不接受的交付方式：**「下載這個修復腳本」「請自己裝 Node」「自己申請 Bot Token／API Key 才能進入主介面」「只有登入按鈕但登入後無法用」「LINE Tab 只有官網連結卻號稱五平台已完成」「明知安裝失敗仍發布 Release」。

## 8. 可以直接貼給 Codex 的開始指令

> 請先閱讀儲存庫根目錄 `consruction.md`，以 `feature/messenger-tabs-experimental` 為開發基礎核對現況。這是一個 Windows/macOS 單一安裝包、五種個人聊天服務 Tab 切換與合規跨平台通知的產品，而非 Bot Token 設定面板。先完成 P0 實作與測試（尤其 LINE 可行性、四平台真人登入、Windows MSI/NSIS 升級、Mac 真實啟動），再進行 P1 跨平台 `@mention`。每項功能必須標明真正端對端驗證與 mock/CI 的差異。不能實現的官方功能請清楚提出合法可行替代及其是否符合使用者要求。未通過五平台驗收前只交付 PR/開發分支，不宣稱完成或發布正式 Release。不得要求一般使用者自行執行修復腳本或填入開發者金鑰。每個 PR 請附測試結果、安裝／登入證據、變更說明和剩餘阻礙。
