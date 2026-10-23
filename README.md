# CrossChat Hub — 分頁桌面客戶端（0.4 開發中）

> **此分支不是 Release，也沒有通過五平台真人帳號的端對端驗證。** 專案維持現有 `v0.3.1` 發行版不變；不會把沒有完成的 LINE 分頁當成已經可使用。

## 桌面工作區

以 Windows/macOS 上的 Electron `WebContentsView` 建立五個 Tab。Telegram、Discord、Slack、WhatsApp 各自開啟**官方網頁客戶端**，使用獨立且持久的 Chromium `session` 保存 Cookie 和網站資料；不要求一般使用者提供 Bot Token、Webhook 或 OAuth Client Secret。跨平台網站輸入帳號密碼時，應確認網址及其登入頁面屬於官方網域。這些登入由網站本身處理，不由 CrossChat Hub 代理。

| Tab | 網頁來源 | 實作狀態 |
|---|---|---|
| Telegram | `https://web.telegram.org/k/` | 分頁嵌入；**真人登入未驗證** |
| Discord | `https://discord.com/app` | 分頁嵌入；**真人登入未驗證** |
| Slack | `https://slack.com/signin` | 分頁嵌入；**真人登入未驗證**，SSO 可能拒絕嵌入瀏覽器 |
| WhatsApp | `https://web.whatsapp.com/` | 分頁嵌入；**真人掃碼未驗證** |
| LINE | 無標準網頁聊天入口 | **暫不支援內嵌私人聊天**；提供官方下載及 Chrome 擴充功能資訊 |

**LINE 不能直接當成一般網頁嵌入。** 官方提供 Windows/macOS 客戶端和 Chrome 擴充功能；Electron 官方僅支援部分 Chrome 擴充功能 API，不能保證載入 LINE Chrome 版本，也不應在未獲許可的情況下重新散佈它。不要使用非官方 LINE 登入網頁。

### 為什麼尚未發行 0.4.0？

正式發行的必要條件：

- Windows x64 MSI / EXE、macOS Intel / Apple Silicon 實體或虛擬機安裝、啟動、正常結束和更新測試成功。
- 四個網頁 Tab 均完成真人帳號登入、傳訊、登出及重新開啟後登入保留測試。
- LINE 有可合法、穩定且可維護的內嵌方法，或產品需求明確允許改用外部官方應用程式。
- 五個平台功能和跨平台 `@mention` 真正完成端對端驗證，而不是只有頁籤和視覺模擬。

現行 GitHub Actions 已調整為**只在明確推送版號 Tag 時建立 Release**，避免把未驗證的提交自動變成 Latest 下載。

## 安全與架構

- 遠端內容以 sandbox、`nodeIntegration: false`、`contextIsolation: true` 執行。
- 不將 Node.js 或檔案系統 API 暴露給第三方聊天網站。
- 各聊天平台使用 `persist:crosschat-<platform>` 隔離 Session；不從網站注入程式碼存取訊息。
- 不以自動化普通使用者帳號的方式繞過平台政策；不儲存網站密碼於本專案資料庫。
- LINE 不會顯示假的「已登入」狀態；聊天平台內容由各官方網頁負責。
- 關閉程式不再等待舊版的本機 HTTP/WebSocket 服務。

## 開發

```bash
npm ci
npm run check
npm test
npm run test:desktop
npm run desktop
```

舊版 Bot 中台 API 和示範介面原始碼保留於 `src/`、`public/`，但不再作為桌面首次啟動首頁。此分支僅供開發審查，不提供未達驗收標準的 Release。

## 2026-10-23：嵌入式桌面操作補強

- 各平台登入 Session 維持隔離並保留，重開視窗會回到上次的 Tab。
- 網頁平台可重新載入、查看未讀數（由官方網頁視窗標題提供）、下載附件並儲存。
- 網站需要麥克風／攝影機／通知時，僅允許平台官方 HTTPS 網域發起，並由桌面程式顯示授權確認。
- 內嵌瀏覽器無法登入時可開啟官方網站，但**外部瀏覽器登入不會自動同步回此程式**。
- Windows NSIS EXE 安裝程式在更新／解除安裝前要求既有視窗正常關閉；程序未退出時中止安裝，避免強制終止或覆寫使用中的 EXE。MSI 仍受 Windows Installer 的鎖定檔案行為限制。
- 未加入任意 Chrome 擴充功能，也沒有自動化讀取私人訊息或替你在另一個平台傳送訊息。

## 本輪開發補強

- 已確認第五個服務沿用 WhatsApp。
- 官方網站、重新導向與多層登入彈窗共用導航限制；一般外部 HTTPS 連結經確認後開啟系統瀏覽器。
- Slack 的已列入清單之 Google／Microsoft／Apple 登入頁可保留內嵌流程；自訂企業 SSO 尚未支援，也未完成真人 SSO 驗收。
- 登入彈窗標題顯示目前來源；第三方登入網域不會獲得聊天平台的媒體／通知權限。
- 修正 Ctrl/Cmd+數字切換後頁籤選取狀態未同步；加入使用獨立暫存資料目錄的 Electron 實際視窗 smoke test。
- 最新測試範圍及未解阻礙請見 [驗收紀錄](docs/acceptance.md)。
