# LINE 個人用戶端路由與跨聊天室轉發

2026-10-23。依使用者最新要求，優先研究 `@line:群組名:人名 後文` 的群組真實提及，以及 `@line:群組名 後文` 的群組發話與跨軟體轉發。本文是來源查證與可測設計，**沒有操作真實聊天、登入或送出訊息，也沒有證明目前原型可用**。

## 可確認的能力與界線

- LINE Windows 官方說明的提及流程是開聊天室、輸入 `@`、**選取候選成員**，再輸入與送出本文。單純貼入 `@顯示名` 不足以證明建立了 LINE mention；提及訊息仍由群組所有成員可見，通知受收件人的設定影響。[官方提及說明](https://help.line.me/line/win/?contentId=20023740)
- 官方 PC 用戶端提供聊天室搜尋，Windows/Mac 搜尋範圍是聊天與訊息。這提供 UI 選房入口，但未提供依顯示名稱唯一定位群組的保證。[官方搜尋及聊天室操作說明](https://help.line.me/line/desktop/?contentId=20005810)
- 官方 LINE URL scheme 文件明確列出 **不支援 Windows/macOS PC**。不得把手機的分享／開聊連結當成可靠 PC 群組路由 API，也沒有在本次來源中找到個人 PC 依「群組名＋人名」直接建立 mention 的官方 API。[官方 URL scheme](https://developers.line.biz/en/docs/messaging-api/using-line-url-scheme/)
- Messaging API 的 `textV2` 確實有結構化 mention：僅 reply/push，目標須是群組／多人聊天室、OA 必須在其中、被提及者也必須在其中，單則最多 20 個。這是 **OA 發話能力**，不等於登入使用者的個人帳號。可作明確選用的另一種 adapter，不能暗中取代個人 UI 路線。[官方 reference](https://developers.line.biz/en/reference/messaging-api/#text-message-v2)

嵌入 Chrome 或原生 LINE 是視窗顯示層；群組選擇、mention 建立與訊息收發仍要另做 adapter。Python、C# 或 Node 都不能僅靠重新 parent HWND 得到聊天內容 API。對本人用戶端的正常 UI 操作，應與攔截認證或仿冒私人協定區分；本設計採正常選房及候選成員操作，不抽 Cookie、不改加密模組、不繞過平台驗證。

## 現有程式與新要求的差距

`src/bridge.mjs` 的 `extractMentions()` 只接受兩段 ASCII alias（例如 `@line:alice`），會遍歷同 alias 的地址並各自投遞；不理解 Unicode 群組名稱或第三段人名。`processIncoming()` 的地址通知送往 `external_user_id`，並非「在指定群組內提及成員」。既有 LINE `sendPlatformMessage()` 送普通 `text`，沒有 `textV2` 或 UI mention。SQLite 已有 source-room → target-room 的 opt-in bridge 與 event 去重，但個人 UI adapter 沒有可直接重用的 webhook 來源事件 ID，也無法沿用 bot 身份過濾防迴圈。

因此新 route 指令必須獨立解析與解析目的地，不能讓舊 alias 正則把 `@line:room:person` 的一部分匹配後發送到舊地址。舊 Bot bridge 是可保留的既有功能，不是這項個人 UI 要求的完成證據。

## 最小可測路徑

1. **固定單一測試目的地。** 使用者在官方已登入的 LINE 中選擇測試群組，Hub 僅記錄經確認的本機 room binding。先測未嵌入原生視窗，再測嵌入；把顯示層失敗與 UI 路由失敗分開。第一次不得掃描全部私人聊天建立索引。
2. **純 dry-run。** `@line:測試群組:測試成員 測試本文` 解析為 platform、room、member、body。UI 顯示預定用戶端、群組、人員與完整本文，這一步不切換真實聊天、不輸入、不發送。名稱有空白或 `:` 時使用明確引號／跳脫文法，不以截斷或模糊比對猜測目的地。
3. **唯一本機綁定。** 名稱不是身份。群組同名、同群組成員同名、帳號切換、候選列不完整、窗口重建或無法重新辨識目標時，回覆歧義／失效，零發送。使用者重新選取精確目標；不能取第一筆或以頭像相似度自動裁決。UI 沒有穩定 ID 時，必須明示綁定只能在該已確認工作階段成立。
4. **準備但不送出。** 在使用者確認的測試群組中，核對聊天室標題／已綁定目標，再檢查輸入框是否已有草稿；有既有草稿就停止，不覆寫。透過正常 UI 輸入 `@` 並選取唯一確認成員，確認候選選取後的 mention 呈現，再輸入本文。沒有成員選單、同名或無法辨識 mention 狀態就停止，不降級成純 `@文字`。此處 UI Automation／可及性元件是否實際暴露，**尚待真實版本檢查**；不預設 pywinauto 可讀所有 Qt/Chromium 元件。
5. **明確指定試送。** 第一次真實發送前，使用者確認測試目的地與本文；實際發送由 adapter 的明確 commit 動作觸發。不得盲送 Enter，因 LINE 官方可將送出鍵改成 Alt+Enter／Command+Enter；先核對設定或可辨識送出控制項。驗證訊息出現在該目的地，並由另一測試帳號確認被提及者可點擊／識別為 mention。通知是否出現另記錄，不能作唯一通過條件。
6. **先完成單向文字轉發。** 使用者明確選取一則來源訊息，建立不可變 envelope，再路由至另一平台的已綁定測試房；驗證來源作者／來源房／本文／順序與目標正確。這是跨平台重新發布，不能聲稱保留 LINE 原生轉發身份、原訊息 ID 或跨平台原生回覆鏈。附件另做支援矩陣，不以只轉檔名表示附件成功。

## 轉發核心應保存的狀態

`ForwardEnvelope` 包含本機 job ID、來源 adapter/account/room、使用者選取的來源訊息參照、作者顯示名、時間、本文及附件描述；`DeliveryPlan` 保存已解析的目標 binding、可選 mention binding 與轉換結果。來源內容中的 `@line:` 或其他命令只視為內容，不能再次觸發路由；只有 Hub 明確指令／已啟用且明確限定來源房的規則可建立任務。

狀態至少區分 `planned → prepared → sending → confirmed`、`failed`、`unknown`。UI 在送出動作後逾時時是 `unknown`，**禁止自動重按送出**；使用者確認目的地是否已有訊息後才能決定。UI 僅有本文雜湊不能精確去重，因同一人可能合法重複發同文。沒有穩定來源 ID 就先保留人工選取的單次轉發，不開啟無人值守雙向橋接。

跨平台 mention 必須重新解析目標平台成員；來源的 LINE mention token 不能原樣貼到 Discord/Slack/Telegram 當成真 mention。未設定身份對應就以普通來源文字呈現並在預覽揭露，不能默認 ping 同名的人。雙向橋接還需要本機 delivery ledger、已發訊息辨識、來源命令不遞迴與明確回送抑制，不能只依賴既有 bot 過濾。

## 驗收矩陣

| 測項 | 通過證據 | 本次狀態 |
| --- | --- | --- |
| `@line:群組 本文` | 指定測試群組真實收到完整本文 | 未執行 |
| `@line:群組:成員 本文` | 正確群組及正確成員的結構化 mention，由另一測試帳號確認 | 未執行 |
| 同名／失效綁定 | 明確歧義且未輸入／未送出 | 設計，未執行 |
| 既有草稿／送出鍵不同 | 不覆寫草稿，未盲送 Enter | 設計，未執行 |
| LINE → 另一軟體 | 已選來源訊息與正確目標的逐項對照 | 未執行 |
| 另一軟體 → LINE | LINE 指定群組收到，mention 另項確認 | 未執行 |
| 送出後連線／視窗中斷 | 保持 unknown，沒有重送 | 設計，未執行 |
| 嵌入與解除嵌入 | 焦點／中文輸入／縮放／彈窗正常，原視窗可還原 | Windows Chrome 視覺嵌入與 LINE parent/style/bounds 還原結構驗證已過；LINE 視覺／輸入／IME／彈窗未驗證，尚未整合正式 Hub |

2026-10-24 checkpoint：個人路由 parser、主程序私有 draft、持久化 reservation
ledger 與 Hub composer preview 已實作；預設個人 adapter registry 為空，因此
unsupported 預覽不會送訊息。此層的 mock／本機檔案測試不證明 LINE 選房或 mention。
原生實驗另外驗證了 top-level broker 在自有 controller 崩潰後保留自有 chat HWND
並正常還原，但不涵蓋 broker 自身崩潰，也未接入產品。證據與未驗證項目見
`experiments/native-host/README.md`；以上真實群組收發驗收仍未執行。

本文件不包含真聊天資料、帳號 Token、用戶端資料庫或截圖。可測方案成立，不等於平台提供或保證自動化介面；UI 可及性與真實 mention 狀態必須以安裝版本做驗證。
