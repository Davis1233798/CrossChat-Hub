# CrossChat Hub v0.3.1 — Windows / macOS 桌面應用程式

## 開箱即可測試

首次開啟點「**開始示範**」即可進入 3 個**本機模擬**聊天室；可以選擇聊天室、傳送訊息、輸入 `@line:alice` 測試**僅本機**跨平台訊息轉送。示範模式不使用或假裝登入外部平台，無需任何外部帳號與金鑰。

## 真正的 Telegram 個人登入

v0.3.1 加入使用 Telegram MTProto（teleproto）的手機號碼＋驗證碼＋2FA（如需要）登入、聊天列表、訊息讀取與傳送。使用者不需要 Bot Token，但 Telegram 要求**第三方應用程式維護者**先在 https://my.telegram.org 取得 `api_id` 和 `api_hash`，並在應用程式的本機 `settings.json` 中配置 `TELEGRAM_API_ID`、`TELEGRAM_API_HASH`（或開發環境變數）。本專案不會將應用程式密鑰放在公開 GitHub。沒有配置時會顯示「待設定應用程式 API」，不會出現虛假的可登入按鈕。此功能的 Telegram 真實端對端驗證需要維護者提供 API 金鑰與真人登入，CI 僅能測試模擬傳輸層；Telegram 帳號新增驗證仍可能因平台要求 Email/reCAPTCHA 而暫時不支援。

已授權的 Telegram `StringSession` 會使用既有 AES-256-GCM 本機加密儲存；請保護 `settings.json` 與使用者資料目錄。不要向使用者索取 Telegram 登入驗證碼或 2FA 密碼，除了在本機程式 UI 直接輸入。

Slack OAuth 需要維護者先配置 Client ID、Secret 和回呼網址。Discord 和 LINE 的 OAuth 只能驗證身分，不提供一般個人聊天讀寫。這些平台目前不能像 Telegram 那樣同步私人聊天。

## Windows 安裝與解除鎖定

v0.3.1 的「**結束程式**」會停止背景服務，並在逾時後強制退出主程序，避免殘留程序鎖住 `.exe`。下載安裝檔前請先關閉 CrossChat Hub，且不要混用 MSI 與 NSIS EXE 當作同一個安裝器的原地更新。如果 Windows 尚保留 v0.3.0 的舊背景程序，先執行 `scripts/repair-windows.ps1`：只會關閉 EXE 路徑在本使用者的 CrossChat Hub 安裝目錄的行程，不會清除用戶資料，不需預設使用管理員權限。執行範例：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\repair-windows.ps1
```

若 MSI 仍失敗，請從「已安裝的應用程式」解除舊版本，再安裝。必要時用 `msiexec /i ... /L*v install.log` 產生診斷日誌。某些沒有簽章的測試版會受到 Windows SmartScreen 或防毒軟體阻擋，這不等於系統管理員權限問題；不要直接關閉整台電腦的安全防護。

## 執行與測試

```bash
npm install
npm run setup
npm test
npm run desktop
```

桌面使用者資料位於 Electron `app.getPath('userData')`，不是程式安裝資料夾。完整架構與進階 Bot/橋接設定請見 `docs/architecture.md` 和 `docs/desktop.md`。專案仍屬未簽章測試版。
