# Mock Jihan Server

模擬 `sv.jihan-pi.jp` / `ws.jihan-pi.jp` 的開發測試伺服器，供 EW-7712ACL 裝置在不連接正式雲端的情況下進行功能驗證。

---

## 專案結構

```
mock-jihan-server/
├── server.js            ← 主入口：HTTP + WebSocket 共用同一個 port
├── db/
│   └── index.js         ← SQLite 初始化、建表、helper 函式
├── routes/
│   ├── index.js         ← 路由掛載總表
│   ├── token.js         ← POST /api/v1/terminal/token
│   ├── status.js        ← POST /api/v1/terminal/status
│   ├── product.js       ← POST /api/v1/terminal/payment/product
│   ├── confirm.js       ← POST /api/v1/terminal/payment/confirm
│   ├── cancel.js        ← POST /api/v1/terminal/payment/cancel
│   ├── close.js         ← POST /api/v1/terminal/close
│   ├── notify.js        ← POST /api/v1/terminal/collation/notify
│   ├── batch.js         ← POST /api/v1/terminal/collation/batch
│   ├── ota.js           ← POST /api/v1/terminal/firmware_update（依 armed 狀態回覆）
│   ├── ota-admin.js     ← /ctrl/ota/*：上傳 / arm / trigger（Web UI 用）
│   └── ota-download.js  ← GET /ota/download/:id：裝置下載韌體映像
├── ws/
│   └── handler.js       ← WebSocket 長連線管理、push 命令
├── public/
│   └── index.html       ← 控制介面 Web UI
├── data/                ← SQLite 資料庫存放處（git 忽略）
│   └── ota/             ← 上傳的 OTA 映像存放處（git 忽略）
├── .env.example
├── .gitignore
└── package.json
```

---

## 技術選型

| 層面 | 選擇 | 理由 |
|------|------|------|
| 語言/框架 | Node.js + Express | JSON 原生處理，快速迭代 |
| WebSocket | `ws` library | 輕量，支援持久長連線，server 可主動 push |
| 儲存 | SQLite (`better-sqlite3`) | 零設定，本地與 Railway 都能直接用 |
| 部署 | Railway.app | 支援持久 Node.js process，原生 HTTPS/WSS，push code 即上線 |

> **為什麼不用 Vercel + Supabase？**
> Vercel 是 Serverless 架構，函式有執行時間限制（10~60 秒），
> 無法維持 WebSocket 長連線。SIM7500 的 `AT+CCHOPEN` 連線需要持續數小時，
> 根本衝突。HTTPS REST API 部分可以用 Vercel，但 WebSocket 無解。

---

## 儲存策略

```
本地開發
  └─ SQLite  data/mock.db
       ├─ terminals    ← 已見過的裝置（IMEI、token、last_seen）
       ├─ api_logs     ← 每次 HTTPS API 呼叫的 req/res 記錄
       ├─ ws_messages  ← 每則 WebSocket 訊息（收/送）
       └─ transactions ← 每筆交易流水（payment_id、金額、狀態）

Railway 部署（需持久化）
  └─ 預設：SQLite 存在容器內，redeploy 後資料消失
  └─ 解法：Railway 加掛 PostgreSQL addon
            只需替換 db/index.js，其餘程式碼不動

多人共用 dev 環境
  └─ 改接 Supabase PostgreSQL（同樣只換 db/index.js）
```

### SQLite 資料表結構

```sql
-- 裝置登記
CREATE TABLE terminals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  imei       TEXT UNIQUE NOT NULL,
  token      TEXT,
  last_seen  TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- HTTPS API 呼叫紀錄
CREATE TABLE api_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  imei          TEXT,
  api_name      TEXT,
  path          TEXT,
  request_body  TEXT,
  response_body TEXT,
  status_code   INTEGER,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- WebSocket 訊息紀錄
CREATE TABLE ws_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  imei       TEXT,
  direction  TEXT,   -- 'recv' | 'send'
  type       TEXT,
  payload    TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 交易流水
CREATE TABLE transactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  imei       TEXT,
  payment_id TEXT,
  api_type   TEXT,
  amount     INTEGER,
  status     TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 上傳的 OTA 韌體映像（Ameba 主韌體或 SIM7500 delta）
CREATE TABLE ota_files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  filename       TEXT NOT NULL,
  stored_path    TEXT NOT NULL,
  size           INTEGER,
  sha256         TEXT,
  kind           TEXT,            -- 'ameba' | 'lte'（由 OTA1 magic 自動判別）
  is_valid_ameba INTEGER DEFAULT 0,
  target_version TEXT,            -- 完成後裝置應回報的版本
  img_len        INTEGER,         -- 由 OTA1 header 解析（僅 ameba）
  checksum       TEXT,            -- OTA1 checksum, hex（僅 ameba）
  download_count INTEGER DEFAULT 0,
  last_download_at TEXT,
  uploaded_at    TEXT DEFAULT (datetime('now'))
);

-- 每台裝置 armed 的 OTA 目標與進度（imei='*' 表示對所有裝置）
CREATE TABLE ota_targets (
  imei           TEXT PRIMARY KEY,
  file_id        INTEGER NOT NULL,
  transport      TEXT NOT NULL,   -- 'ameba' | 'lte'
  target_version TEXT,
  state          TEXT DEFAULT 'armed', -- armed|offered|downloading|downloaded|verified|already_current
  offered_count  INTEGER DEFAULT 0,
  bytes_sent     INTEGER DEFAULT 0,
  armed_at       TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);
```

---

## HTTPS API 對照表

所有 API 皆為 `POST`，路由前綴 `/api/v1/terminal`。

| API 名稱 | 路徑 | 觸發時機 | Mock 回應重點 |
|---------|------|---------|-------------|
| token | `/token` | 開機，Flash 無 token 時換取 | 回傳 64 字元隨機 token |
| status | `/status` | 開機完成、伺服器要求、每日對帳後 | `{ result: 0 }` |
| product | `/payment/product` | 消費者按選品（DC11） | 回傳商品價格、inquiry_balance、select_timer |
| confirm | `/payment/confirm` | NFC 讀卡成功後扣款 | 回傳 payment_id、剩餘餘額 |
| cancel | `/payment/cancel` | 逾時或使用者取消 | 回傳 cancel_reason |
| close | `/close` | 結帳（DC16） | `{ result: 0 }` |
| notify | `/collation/notify` | 每筆 CL / 現金交易後上傳 POS | `{ result: 0 }` |
| batch | `/collation/batch` | 每日批量對帳 | `{ result: 0 }` |
| ota | `/firmware_update` | 開機 / WS 觸發 FOTA 查詢 | 依 armed 狀態回 `needs_update`+`url`（Ameba）或 `lte_needs_update`+`lte_url`（LTE 模組）；未 arm 時全為 false。詳見「OTA 測試」 |

---

## WebSocket 訊息對照表

WebSocket 連線路徑：`ws://<host>/<IMEI>`

### 雲端下發（Server → 裝置）

| `type` | 功能 | 額外欄位 |
|--------|------|---------|
| `status_request` | 要求裝置上報狀態 | 無 |
| `buzzer_request` | 觸發蜂鳴器 | `buzzer: 1~4` |
| `firmware_update` | 觸發 OTA 更新 | 無 |
| `reboot_request` | 遠端重開機 | 無 |
| `log_start_request` | 開始記憶體 log 收集 | 無 |
| `log_stop_request` | 停止記憶體 log 收集 | 無 |
| `clear_request` | 清除 collation / POS Queue，然後 reboot | 無 |
| `payment_confirm_request` | 下發 NFC 付款確認結果 | `payment_id`, `result`, `method`, `brand` |

### 裝置上送（裝置 → Server）

| Frame 類型 | `type` | 內容 |
|-----------|--------|------|
| Text (0x81) | `log` | `{ "type":"log", "messages":"..." }` |
| Ping (0x89) | — | 協定層保活，`ws` library 自動回 Pong |

---

## 控制介面（Web UI）

開瀏覽器訪問 `http://localhost:3000`：

- **左欄**：選擇連線中的裝置，一鍵推送各種 WS 命令
- **右欄**：即時 WS 訊息 log（綠色=裝置送來，藍色=伺服器送出）
- **底部**：HTTPS API 呼叫紀錄（顯示最近 50 筆）
- **OTA 面板**：上傳韌體映像、arm 給裝置、即時看下載與驗證進度（見下節）
- 每 5 秒自動刷新

---

## OTA 測試

讓你把一份 OTA 映像上傳到 mock server，指定給某台裝置，然後端對端觀察整條 OTA 機制是否成功。支援兩條路：

- **Ameba 主韌體**：上傳 `EW7712ACL_v<版本>.bin`（含 `OTA1` frame header，會被自動辨識），對應 `needs_update` / `url`。
- **SIM7500 模組 delta**：上傳 delta 包（無 `OTA1` magic，自動歸類為 `lte`），對應 `lte_needs_update` / `lte_url`。

### 關鍵前提

- 裝置下載固定走 **HTTPS 443**（韌體 `AT+CHTTPSOPSE="host",443,2`），所以下載 URL 必須是裝置連得到的 HTTPS host。用 `PUBLIC_BASE_URL` 指定（VPS 為 `https://mock-jihan.ddns.net`）；未設則回退到請求自身的 host。
- 下載端點回 `Content-Type: application/octet-stream` + 正確 `Content-Length`，bytes 原封不動；checksum 由**裝置自己**回讀 flash 驗證，server 不驗。

### 操作步驟（Web UI）

1. 在「OTA 韌體更新」面板選檔上傳 → 顯示 `kind` / `OTA1✓` / `ImgLen` / `checksum` / 解析出的版本。
2. 上方先選好目標裝置（`select terminal`），按檔案列的 **arm→選定**（或 **arm→全部** 對所有裝置）。
3. （可選）按 **立刻觸發** → 推 WS `firmware_update`，裝置立即查詢並開始 OTA，不必等重開機。
4. 看「Arm 狀態 / 驗證進度」：`① 已提供 → ② 下載中 → ③ 下載完成 → ④ 已驗證 ✅`。裝置重開機後回報的版本 == 目標版本時，即標記 **verified**。

> **版本比對**：目標版本預設從檔名 `v<版本>` 解析（如 `EW7712ACL_v9.280.bin` → `9.280`），arm 時可覆寫。裝置回報同版本前，server 會持續回 `needs_update=true`（支援韌體端 10 分鐘重試），避免下載失敗就中斷。

### 控制台 API（也可用 curl）

| Method | 路徑 | 說明 |
|--------|------|------|
| POST | `/ctrl/ota/upload?name=<檔名>` | 上傳（body 為 raw binary） |
| GET | `/ctrl/ota/files` | 列出已上傳映像 |
| DELETE | `/ctrl/ota/files/:id` | 刪除映像 |
| POST | `/ctrl/ota/arm` | `{ imei\|"*", file_id, transport?, target_version? }` |
| POST | `/ctrl/ota/disarm` | `{ imei }` |
| POST | `/ctrl/ota/trigger` | `{ imei }`：推 WS `firmware_update` |
| GET | `/ctrl/ota/status` | 所有映像 + 每台 arm 狀態與進度 |
| GET | `/ota/download/:id` | 裝置下載端點（公開、無認證） |

```sh
# 上傳
curl -X POST "http://localhost:3000/ctrl/ota/upload?name=EW7712ACL_v9.280.bin" \
     --data-binary @EW7712ACL_v9.280.bin
# arm 給某台裝置
curl -X POST http://localhost:3000/ctrl/ota/arm \
     -H 'Content-Type: application/json' \
     -d '{"imei":"<IMEI>","file_id":1,"transport":"ameba"}'
# 立刻觸發
curl -X POST http://localhost:3000/ctrl/ota/trigger \
     -H 'Content-Type: application/json' -d '{"imei":"<IMEI>"}'
```

> OTA 傳輸層/雙 slot/斷電原子性等機制細節見主韌體 repo 的 `doc/OTA_LTE_FOTA.md` 與 `doc/OTA_MECHANISM.md`。

---

## 本地開發

```bash
# 1. 安裝依賴
npm install

# 2. 建立環境設定
cp .env.example .env

# 3. 啟動（開發模式，檔案變更自動重啟）
npm run dev

# 4. 正式啟動
npm start
```

裝置側：把 CFG 的伺服器指向本機 IP，需要 HTTPS/WSS，
用 ngrok 建立安全通道：

```bash
ngrok http 3000
# 取得 https://xxxx.ngrok-free.app
# 在裝置 CFG 填入此 domain
```

---

## 部署到 Railway

```bash
# 1. 安裝 Railway CLI
npm install -g @railway/cli

# 2. 登入並初始化
railway login
railway init

# 3. 部署
git add .
git commit -m "init mock server"
railway up

# 4. 取得部署 URL
railway domain
# 回傳類似 https://mock-jihan-server-production.up.railway.app
```

Railway 會自動：
- 偵測 Node.js 專案並執行 `npm start`
- 提供 `*.railway.app` 域名與有效 SSL 憑證
- 支援 WebSocket 長連線（不受 Serverless 限制）

### 需要持久化資料時

Railway 加掛 PostgreSQL：

```
Railway Dashboard → 專案 → + New → Database → PostgreSQL
```

取得 `DATABASE_URL` 環境變數後，將 `db/index.js` 的
`better-sqlite3` 替換為 `pg`，其餘路由與 WS handler 完全不動。

---

## 注意事項

- Mock response 中的 `article_price`、`inquiry_balance` 等數值為預設假資料，
  需依照實際 API spec 調整 `routes/product.js` 的回傳格式
- OTA 預設不更新（未 arm 時 `needs_update` / `lte_needs_update` 皆為 false）；
  要測 FOTA 流程請用 Web UI 的「OTA 韌體更新」面板或 `/ctrl/ota/*` API 上傳並 arm，
  不需再手改 `routes/ota.js`（見「OTA 測試」章節）
- WebSocket 的 `payment_confirm_request` 內容格式需對照 `gplus_at_pay.c` 的 parse 邏輯確認欄位名稱
