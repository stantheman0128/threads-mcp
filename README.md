# Threads MCP

Grok Bot 可透過獨立金鑰保護的遠端 HTTP 入口，沿用帳號持有者電腦已登入的 Threads，維持 15 個結構化唯讀工具。長期使用推薦固定 hostname 的 Cloudflare managed tunnel；Quick Tunnel 僅供臨時除錯。先看 [遠端部署與分層診斷](docs/REMOTE-MCP.md)、[Windows 登入啟動與恢復](docs/WINDOWS-REMOTE-HOST.md)，再依 [Grok 的 mcp-remote/header-file 設定](docs/GROK-BOT.md) 連線。搜尋工具可自行導向與捲動，不需要使用者手動滑頁；Chrome／bridge 重啟後仍需手動配對，不能把 19758 配對主機公開。

**Grok Bot 安裝入口：[docs/GROK-BOT.md](docs/GROK-BOT.md)**。使用既有遠端服務時，Bot 只需 mcp-remote 與私有 header file，Chrome／Threads 登入留在帳號持有者電腦。本機 stdio 是另一種安裝方式；GitHub 連結本身不是遠端 MCP 端點。

本機執行的 Threads MCP：沿用你選定的 Chrome 登入分頁，擷取可見貼文／互動資料，用本機多語 embedding 做語意與模糊搜尋，並提供草稿、媒體、準備後執行的社交操作與 optional 官方 API。v0.5.1 共 44 個 MCP 工具。Node.js 24+；已在 Windows PowerShell 驗證啟動與 stdio 協定。

歷史實機驗證（2026-10-24）：231 項自動測試通過、1 項平台不適用跳過；完整瀏覽器驗收與五項背景流程通過。頁面程式修訂為 `20261024-readiness-3`。2026-11-06 公開匯出另通過預設測試、型別檢查、建置及 MCP 協定檢查；尚未在 Grok Bot 雲端環境實測。公開發文、實際刪除、媒體上傳與排程沒有在真實帳號上執行測試；各能力的證據與限制見 [VERIFICATION.md](docs/VERIFICATION.md)。

**v0.5.0 公開個人貼文直接分頁已實測。** 對現有 `threads_get_profile` 傳入 `provider:"direct"`、`section:"posts"`、`maxPages:4`、`pageSize:5`，會沿用登入分頁直接連抓多頁，不需捲動。回傳每頁新增筆數、去重結果及停止原因；最多5頁，含初始頁，仍標示partial。HTTP、HTTPS與mcp-remote/header-file實測各取得4頁19篇，再接續取得另一目標3頁14篇。既有Grok連線需重啟／刷新工具schema，網址與金鑰不必更換。詳見 [使用指南](docs/GROK-BOT.md)。
v0.5.1 支援明確啟用的遠端受控寫入：預設15個唯讀工具；設定 THREADS_REMOTE_ALLOW_WRITES=true 後為18個，新增檢查／準備／單次執行，保留帳號與內容核對。僅文字發文、回覆、引用及指定社交互動；刪文、私訊、媒體與任意控制不開放。詳見 [受控寫入](docs/REMOTE-MCP.md#controlled-remote-writes-v051-explicit-opt-in)。

## 能做什麼

| 工具 | 用途 |
|---|---|
| `threads_status` | 查看連線、索引與限制 |
| `threads_search` | Threads 關鍵字探索＋本機語意／模糊排序；支援多組關鍵字、作者、日期、最低按讚數 |
| `threads_research` | 多來源研究：搜尋變體、已說讚／已儲存、自己的貼文／回覆、指定作者；可展開回覆、限制每位作者的結果數 |
| `threads_my_activity` | 以目前登入帳號讀取自己的貼文、回覆、轉發、已說讚或已儲存，建立可搜尋的觀測集合 |
| `threads_find_mentions` | 尋找明確 @帳號與名稱／品牌候選；排除 email 或較長帳號的誤判，查不到回報未知 |
| `threads_get_notifications` | 逐列通知候選、列內帳號與貼文連結、時間；無法確認的事件類型保留 unknown，開啟可能更新已讀狀態 |
| `threads_get_post` | 貼文、可取得的按讚／回覆／轉發數 |
| `threads_get_post_activity` | 精確貼文的按讚／轉發名單；核對選中畫面，顯示總數與觀察名單分開 |
| `threads_get_replies` | 已辨識的留言；其他可見貼文另外列出 |
| `threads_get_profile` | 個人檔案、貼文／回覆／媒體／轉發分頁 |
| `threads_get_feed` | 首頁、追蹤中、已儲存、已說讚，以及通知／訊息可見文字 |
| `threads_get_connections` | 有界的粉絲／追蹤中清單 |
| `threads_check_relationship` | A 是否追蹤 B：已觀察到為 true，清單不完整而未找到為 unknown |
| `threads_read_page` | 目前頁面資料，或指定 Threads 網址 |
| `threads_browser_snapshot` | 畫面控制項與短效操作參照 |
| `threads_browser_scroll` | 捲動目前頁面／對話框，再讀取 |
| `threads_prepare_action` | 準備一個點擊、填字、按鍵或選取操作，綁定畫面與登入帳號 |
| `threads_execute_action` | 執行準備好的操作一次，回傳新畫面供驗證 |

v0.4.2 另外提供以下工具群。程式、隔離瀏覽器測試與真實帳號驗證是不同層級，具體結果見 [VERIFICATION.md](docs/VERIFICATION.md)。

| 工具群 | 用途 |
|---|---|
| `threads_search_users`、`threads_discover` | 個人檔案搜尋、網站熱門／最近結果 |
| `threads_reply_inbox`、`threads_account_insights` | 有界回覆收件匣、目前帳號網頁洞察摘要及歷史觀測 |
| `threads_collect`、`threads_trends`、`threads_observed_analytics` | 增量去重、關鍵字樣本比較、相同貼文的計數變化 |
| `threads_batch_read`、`threads_export` | 批次讀取與 JSON／CSV 匯出，附查詢及來源 provenance 檔 |
| `threads_inspect_social`、`threads_prepare_social`、`threads_execute_social` | 唯讀檢查狀態，再準備及一次性執行按讚／取消讚、儲存、轉發、追蹤、文字發文／回覆／引用，以及本人貼文刪除選單 |
| `threads_stage_media` | 明確指定的本機圖片／影片分塊上傳到空白編輯器，取得綁定檔案的 mediaToken；不會發佈 |
| `threads_api_status/read/prepare/execute` | 官方 API 的搜尋、mentions、insights、媒體／carousel、刪除與回覆審核等具型別操作 |
| `threads_save_draft/list_drafts/delete_draft` | 帳號隔離的本機草稿 |
| `threads_stage_schedule/list_schedules/authorize_schedule/cancel_schedule/run_schedules/reconcile_schedule` | 不可變的排程內容、明確授權、串文、取消與不確定結果處理 |

瀏覽器操作必須先位於精確的目標貼文／個人檔案頁；發新文使用首頁。程式不覆寫既有草稿，介面不明確就停止。文字發文需要新連結、作者、文字與時間證據才回報 verified；回覆／引用關係或遠端媒體未能證實時保留 uncertain。瀏覽器刪除可準備本人貼文選單；若出現額外確認，停在 confirmation-required，貼文消失不算已證實刪除。媒體 alt text 與一般已發佈貼文編輯仍未提供專用瀏覽器流程。詳見 [SOCIAL-ACTIONS.md](docs/SOCIAL-ACTIONS.md)、[MEDIA.md](docs/MEDIA.md) 與 [OFFICIAL-API.md](docs/OFFICIAL-API.md)。讀取訊息可能讓 Threads 將訊息標為已讀。

排程執行預設使用瀏覽器，文字發文不需要官方 API；需登入帳號一致、已授權的不可變內容與持續執行的呼叫端。瀏覽器排程媒體尚不支援，回覆／引用若缺少關係證據則停止並保留 uncertain。沒有自動安裝計時器或啟動任何真實排程。詳見 [BROWSER-PUBLISHING.md](docs/BROWSER-PUBLISHING.md)。

## 快速啟動

```powershell
Set-Location C:\path\to\threads-mcp
npm ci
npm run build
npm start
```

`npm start` 是 stdio MCP 服務，通常由 MCP client 啟動；它等待 JSON-RPC 輸入，不是聊天式終端機。不要和另一個使用相同連接埠的服務同時啟動。

在 MCP client 設定以下伺服器（絕對路徑可依安裝位置修改）：

```json
{
  "mcpServers": {
    "threads": {
      "command": "node",
      "args": ["C:/path/to/threads-mcp/dist/cli.js", "serve"],
      "env": {
        "THREADS_PROVIDER": "extension",
        "THREADS_DATA_DIR": "C:/path/to/threads-mcp/.threads-data",
        "THREADS_ALLOW_WRITES": "false"
      }
    }
  }
}
```

Codex TOML 對應設定範例在 [docs/codex-mcp.toml](docs/codex-mcp.toml)。尚未自動修改你的全域 MCP 設定。

MCP 伺服器、瀏覽器連接器與頁面 runtime 為 v0.5.0。升級需重啟本機 bridge／HTTP、重新載入擴充功能並配對分頁，才能使用直接個人貼文分頁。

## 使用現有 Chrome 登入

1. 建議先執行 `npm run bridge` 啟動持續配對服務；MCP client 和 `npm run test:live` 會自動連到同一個服務，結束時保留瀏覽器連線。也可讓 MCP client 自行啟動服務，但該 client 結束時會一起停止。
2. 在 Chrome 的 `chrome://extensions` 開啟開發人員模式，載入未封裝項目 `C:\path\to\threads-mcp\extension`。
3. 開啟 `http://127.0.0.1:19758/`，複製本次配對碼。
4. 手動選取已登入的 Threads 分頁，點「Threads MCP 本機連接器」圖示，貼上配對碼後按「連接此分頁」。
5. 呼叫 `threads_status` 確認 connected，再使用讀取／搜尋工具。

請讓這個分頁專供 Threads MCP 使用，避免同時交給 Codex 的瀏覽器控制工具。實機驗收曾確認後者暫停同一分頁的文件回應，造成 MCP 跳頁逾時；改由使用者開啟新分頁並重新連接 Bridge 後，跨頁讀取及下一輪讀取恢復正常。遇到這種衝突時，不需要重新登入或重新安裝擴充功能。

程式只連接選定分頁；不讀 Cookie。關閉分頁、離開 Threads、在 popup 中斷線或停止服務都會斷線。服務重新啟動會產生新配對碼，需要重新配對。**v0.4.2 的讀取、導覽、捲動、粉絲／追蹤清單與搜尋已通過背景實機驗證**，五項流程開始與結束都確認為 hidden，不會替你切換分頁或聚焦視窗，你可以同時使用其他分頁或應用程式。通用寫入互動仍要求作用中分頁；截圖另要求該視窗在前景。完整權限與傳輸設計見 [docs/BRIDGE.md](docs/BRIDGE.md)。可用 `npm run test:background` 重跑五項唯讀流程；報告分別列出功能結果與實際 hidden 狀態，不把前景成功當成背景成功。

從 v0.1.0 更新時，需在 Chrome 擴充功能管理頁重新載入連接器一次，讓新的背景程式生效，再連接原本的 Threads 分頁。這不需要重新登入 Threads；如果配對服務未重啟，配對碼維持不變。

替代方案是專用登入：先 `npm run login` 手動登入，關閉專用視窗，再以 `THREADS_PROVIDER=dedicated` 啟動 MCP。這使用專案自己的 Chrome profile，與既有個人 profile 分開。

## 語意搜尋的實際範圍

Threads 本身仍提供關鍵字候選；agent 可把自然語言問題拆成最多五組探索詞。例如「不想上班，想找一個人做產品的經驗」可探索「獨立開發」「一人公司」「副業」，再以原始問題做 semantic／hybrid 排序。

```json
{
  "query": "一個人做產品而不用每天進辦公室",
  "queries": ["獨立開發", "一人公司", "遠端工作"],
  "mode": "hybrid",
  "refresh": true,
  "rounds": 2,
  "limit": 20
}
```

搜尋涵蓋**這個本機索引曾觀察到的貼文**，不是整個 Threads 的全站語意索引。`refresh:false` 只查已收集資料，不需瀏覽器連線。結果附 method、詞彙／語意分數與 warnings；模型無法載入時會明確標示 lexical fallback，不假裝已做語意搜尋。模型第一次使用會從 Hugging Face 下載；之後本機推論，貼文文字不送到外部 embedding API。技術細節見 [docs/SEARCH.md](docs/SEARCH.md)。

缺少的按讚數為 null；僅有部分粉絲清單時不回報「沒有追蹤」。私人帳號、登入挑戰、限流與介面改版會讓資料不完整或需要手動處理。

### 多來源研究

`threads_research` 支援 `sources: ["search", "liked", "saved", "my_posts", "my_replies", "profiles", "local"]`；只指定需要的來源。`queries` 由 agent 依原始問題提供同義詞／中英文變體，原始 `query` 用於最後的語意排序。最多十個來源／關鍵字頁面，每頁捲動最多三輪；`includeReplies:true` 另外展開最多三篇候選貼文的回覆。

可搭配 `since`、`until`、`author`、`minLikes`、`excludeTerms`、`onlyReplies`、`maxPerAuthor`。每筆結果附來源 collection 與首次／最近觀測時間。`refresh:false` 可離線搜尋已收集來源；個人來源需要指定 `account`，不會猜登入帳號。歷史 liked/saved membership 不代表現在仍按讚或儲存；部分刷新不刪掉未出現的歷史紀錄。已確認的貼文／回覆分類矛盾會修正該 collection，保留原貼文與其他集合。

```json
{
  "query": "台灣獨立開發者如何找到第一批付費用戶",
  "queries": ["獨立開發 付費用戶", "indie hacker Taiwan", "第一筆收入"],
  "sources": ["search", "saved"],
  "mode": "hybrid",
  "excludeTerms": ["抽獎"],
  "includeReplies": true,
  "maxPerAuthor": 3,
  "limit": 20,
  "rounds": 1
}
```

`threads_find_mentions` 將明確 `@帳號` 與顯示名稱／品牌文字候選分開；後者不是身分證明。`threads_get_notifications` 則讀取你目前可見的通知。兩者都不等於完整的全站提及索引。

## 啟用寫入

將 MCP 環境變數 `THREADS_ALLOW_WRITES` 設為 `true` 並重啟服務。此設定開放 UI 互動機制，不等於授權 agent 任意發文、傳訊、刪除或修改帳號；agent 仍需依使用者具體指令操作。

通用 UI 流程為 snapshot → prepare → execute → 檢查回傳畫面。具名操作則使用 prepare_social → execute_social。準備時綁定登入帳號、網址、控制項、草稿和媒體；執行前再核對。每個 action ID 只消耗一次，逾時不重送。`verified:false` 或 uncertain 表示結果仍需核對。

排程預設使用瀏覽器文字發文，需要登入帳號及已連接的本機 Bridge；加上 `--api` 才使用選用的官方 API，並需要自己的 Meta Threads 授權及 numeric account ID。API token 僅放在本機程序環境，勿貼到聊天、指令引數或文件。先 save_draft → stage_schedule，檢查完整內容和帶時區的時間，再 authorize_schedule。可用 MCP run_schedules 手動處理到期工作，或在已配置環境中執行：

```powershell
node dist/cli.js schedule-worker <account-id-or-username>
```

worker 每 30 秒檢查一次，只執行已明確授權的工作；Windows 休眠／程序關閉時不會執行，也尚未安裝成系統服務。每篇成功後才串接下一篇；不確定結果不重送。媒體處理最多等候約 120 秒，未完成會保留容器 ID 和停止原因，不能藉重新建立容器來假裝重試成功。詳見 [WORKFLOWS.md](docs/WORKFLOWS.md)。

## 資料與驗證

本機索引、模型、配對碼、專用 profile 與最小操作記錄在 `.threads-data/`，已排除 Git。不要分享該資料夾。工具結果只輸出正規化資料與可見文字；不回傳 Cookie 或原始頁面 scripts。

```powershell
npm run typecheck
npm test
npm run build
npm run test:mcp
npm run test:live
```

`test:mcp` 是真實 stdio client/server 握手與工具呼叫；不啟動帳號瀏覽器。`test:live` 等待手動配對最多十分鐘，測試目前頁面／單篇貼文／粉絲與追蹤入口，寫下 `.threads-data/live-smoke.json`。如果是連到既有 `bridge` 服務，測試結束保留連線；如果測試自行啟動橋接，則會關閉自己啟動的服務。未配對會記為 BLOCKED 並以 exit code 2 結束。它不發文或改動社交關係。實際模型測試可執行 `npx tsx scripts/semantic-smoke.ts`；報告保存在 `.threads-data/semantic-smoke/report.json`。
