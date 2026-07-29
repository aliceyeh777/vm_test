# Mock Jihan Server — VPS 部署文件

## 基本資訊

| 項目 | 值 |
|------|-----|
| VPS IP | `147.182.172.24` |
| 公開網域 | `mock-jihan.ddns.net` |
| DDNS 服務 | No-IP（帳號 `aliceyeh1214`，每 30 天需確認一次） |
| SSL 憑證 | Let's Encrypt，到期日 2026-09-07（自動續期） |
| Node.js 路徑 | `/opt/mock-jihan/` |
| GitHub Remote | `https://github.com/aliceyeh777/vm_test.git` |

---

## 伺服器端點

| 協定 | 網址 | 用途 |
|------|------|------|
| HTTPS | `https://mock-jihan.ddns.net/api/v1/terminal/*` | REST API |
| WSS | `wss://mock-jihan.ddns.net/` | WebSocket 長連線 |
| Web UI | `https://mock-jihan.ddns.net/` | 控制介面 |

> 另有一條 **Cloudflare Tunnel**（`*.trycloudflare.com`）作為第二條對外入口，同樣代理到 `localhost:3000`。網址會變動，詳見下方「Cloudflare Tunnel」章節。裝置端固定用 `mock-jihan.ddns.net`，不要用 tunnel 網址。

---

## SSH 連線

```bash
ssh root@147.182.172.24
```

---

## nginx 設定

設定檔位於 `/etc/nginx/sites-available/mock-jihan`。

```nginx
server {
    listen 80;
    server_name mock-jihan.ddns.net;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name mock-jihan.ddns.net;
    ssl_certificate /etc/letsencrypt/live/mock-jihan.ddns.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mock-jihan.ddns.net/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # OTA 韌體上傳（POST /ctrl/ota/upload）body 可達數 MB；
    # nginx 預設 1m 會讓上傳回 413，Node 端上限為 32m。
    client_max_body_size 64m;

    location /ctrl/events {          # SSE：必須關掉 buffering，否則事件不會即時吐出
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";   # ← 必須是字串 "upgrade"，不能用 $http_upgrade
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### ⚠️ 上傳大小上限（`client_max_body_size`）

nginx 預設 `client_max_body_size` 為 **1 MB**，OTA 韌體映像目前約 1.0 MB，已幾乎貼齊上限；
未加此設定時，映像再長一點上傳就會回 **413 Request Entity Too Large**（請求被 nginx 擋下，
根本不會進到 Node，UI 上看起來像是「上傳沒反應」）。

本設定已於 2026-07-29 加到 443 server block（`client_max_body_size 64m;`），
舊設定備份為 `/etc/nginx/sites-available/mock-jihan.bak-20260729`。

改完務必：

```sh
nginx -t && systemctl reload nginx
```

> 走 Cloudflare Tunnel 那條入口不吃這個設定，但 Cloudflare 免費方案本身有 100 MB 的 body 上限。

### ⚠️ WebSocket 設定重點

`proxy_set_header Connection` 必須設為字串 `"upgrade"`，**不能**寫成 `$http_upgrade`。

- `$http_upgrade` 的值是 `"Websocket"`（Upgrade header 的值）
- nginx 需要看到 `Connection: upgrade` 才會切換成 WebSocket proxy 模式
- 若寫錯，nginx 會把 WS upgrade 請求當成一般 GET，Express 回傳首頁 HTML（`HTTP 200`），導致韌體報 `Switching Protocols failed`

---

## Cloudflare Tunnel（第二條對外入口）

除了 nginx + DDNS 之外，VPS 上還跑了一條 **Cloudflare Quick Tunnel**，由 pm2 管理（程序名 `cloudflare-tunnel`），把 `http://localhost:3000` 直接對外暴露成一個 `*.trycloudflare.com` 網址。

| 項目 | 值 |
|------|-----|
| pm2 程序名 | `cloudflare-tunnel` |
| 啟動指令 | `cloudflared tunnel --url http://localhost:3000 --no-autoupdate` |
| 設定檔 | **無**（quick tunnel，非 named tunnel，沒有 `config.yml` / 憑證） |
| cloudflared 版本 | `2026.5.2` |
| 目前網址 | `https://obligations-describes-offline-alone.trycloudflare.com`（**會變動**） |

### ⚠️ 網址是臨時的

Quick tunnel 每次 **cloudflared 程序重啟**（`pm2 restart cloudflare-tunnel`）都會拿到一組**全新的隨機 `*.trycloudflare.com` 網址**。它只在程序持續存活期間穩定（QUIC 斷線重連不會換網址，但 pm2 重啟會）。

因此：

- **不要**把 tunnel 網址當成裝置的固定 endpoint；裝置 CFG 一律用 `mock-jihan.ddns.net`。
- tunnel 適合臨時分享 / 備援對外存取（例如 DDNS 過期或 nginx 出問題時）。

### 查目前網址

```bash
pm2 logs cloudflare-tunnel --lines 50 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com'
# 或直接翻 log 檔
grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /root/.pm2/logs/cloudflare-tunnel-*.log | tail -1
```

> 若要固定網址，需改用 **named tunnel**（`cloudflared tunnel create` + `config.yml` 綁定自有網域），本專案目前未採用。

---

## PM2 程序管理

```bash
pm2 list                    # 查看執行中的程序
pm2 restart mock-jihan      # 重啟（約 1~2 秒，WS 連線會瞬間斷線）
pm2 logs mock-jihan         # 查看即時 log
pm2 logs mock-jihan --lines 100   # 查看最近 100 行 log
```

---

## 部署流程

### 日常改版（本地改好後）

```bash
# 1. commit 變更
git add .
git commit -m "說明改了什麼"

# 2. 一鍵部署（push 到 GitHub + VPS git pull + pm2 restart）
./deploy.sh
```

### deploy.sh 內容

```bash
#!/bin/bash
set -e

VPS="root@147.182.172.24"
REMOTE_DIR="/opt/mock-jihan"

echo "==> git push to GitHub ..."
git push

echo "==> VPS: git pull + pm2 restart ..."
ssh "$VPS" "cd $REMOTE_DIR && git pull && pm2 restart mock-jihan"

echo "==> Deploy done!"
```

---

## 裝置 CFG 設定

裝置 CFG 的 WebSocket server 選擇欄位（`ws_server`）設為 `"AWS"` 時，伺服器指向：

| 欄位 | 值 |
|------|-----|
| HTTPS host | `mock-jihan.ddns.net` |
| WebSocket URL | `wss://mock-jihan.ddns.net/` |

---

## 支付流程驗證（正常狀態）

裝置開機後完整流程的 log 關鍵字：

```
[simcom7500_websocket_connect:1805] upgrade: websocke Switching Protocols ok
[PONG] 8A 00
[lte_keep_loop:2543] status_api(terminal_start) OK
[lte_keep_loop:2548]  LTE Keep Main Loop  ...
```

一筆完整 NFC 支付的狀態序列：

```
PRODUCT_SELECT → PRODUCT_API → PAYMENT_CONFIRM_REQ
→ PAYMENT_CONFIRM → PAYMENT_SUCCESS → POS_NOTIFY → POS_NOTIFY_SUCCESS → STANDBY
```

---

## 已知問題排除

### WS init fail（`Switching Protocols failed`）

**現象**：裝置發出 WS upgrade 請求，server 回 `HTTP 200` + HTML 頁面。

**原因**：nginx `proxy_set_header Connection $http_upgrade;` 寫法錯誤。

**修正**：
```bash
# 在 VPS 上執行
sed -i 's/proxy_set_header Connection \$http_upgrade;/proxy_set_header Connection "upgrade";/' \
  /etc/nginx/sites-available/mock-jihan
nginx -t && systemctl reload nginx
```
