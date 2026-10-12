# Bot 容器部署

Bot 使用獨立的 Docker Compose 服務，不修改 Hermes 服務或 8646 埠，也不把 3000 埠公開到 VPS 主機。Traefik 透過既有 Docker 網路代理 `https://bot.sameheart-design.com`，並使用既有 Let's Encrypt resolver。

## 手動部署／更新

在 VPS 上的專案目錄執行：

```sh
docker compose -f compose.bot.yaml config -q
docker compose -f compose.bot.yaml up -d --build
```

只會建立或更新 `sanhe-bot` 服務。不要對整個 Hermes Compose 專案執行 `down`。更新程式碼後，在此目錄再次執行第二個指令即可重建並重啟 Bot。

正式部署前確認 `.env` 已存在且權限限制為服務使用者可讀；Compose 會載入其中既有的 Meta 與 Supabase 設定。`PUBLIC_BASE_URL` 會由 Compose 固定為正式 HTTPS 網址。不可將 `.env` 放入映像檔或 Git。

管理頁新增環境變數：`META_APP_ID`、`META_LOGIN_CONFIG_ID`（Login for Business：User access token、Pages）、`ADMIN_FB_USER_IDS`（App 範圍使用者 ID，逗號分隔）、`ADMIN_SESSION_SECRET`（獨立隨機值，至少 32 bytes）、`ADMIN_ALLOWED_PAGE_ID=157645098246646`，以及選填 `ADMIN_ALLOWED_BUSINESS_ID`；共用既有 `META_APP_SECRET` 與 `PUBLIC_BASE_URL`。僅在主機私下設定並確認 `sanhe-bot` 容器有取得這些鍵，不將值放入 repo。缺新設定只令 `/admin` 回 503。Cookie 固定使用 Secure／HttpOnly／SameSite=Lax／Path=/admin；登入與送出以固定 `PUBLIC_BASE_URL` 核對來源。現有 `TRUST_LOCAL_PROXY` 只信 loopback，跨容器 Traefik 的可信來源及轉送標頭需在 VPS 核對後另案調整，不可設為無條件信任；未調整時登入限流可能由代理後的使用者共用。

Messenger 表單 Webview 與送出後自動返回對話預設關閉。先在 Meta Messenger 設定中允許 `bot.sameheart-design.com` 網域，再於 VPS `.env` 設定 `MESSENGER_WEBVIEW_ENABLED=true`，並只重啟 `sanhe-bot` 才啟用。若表單是在外部瀏覽器開啟，自動返回功能不一定可用；完成頁會提示使用者手動回到 Messenger。

Compose 會把原專案的 `config/` 以唯讀方式掛入，讓 `.env` 既有的 `QUESTIONS_PATH` 繼續讀取原題庫；不要替換或修改題庫檔案。

## 自動更新

GitHub Actions workflow、VPS 限權部署帳號與 GitHub repository secret `SANHE_DEPLOY_KEY` 均已設定。推送到 `main` 後會先測試，再只部署 Bot 服務。私鑰只存在 GitHub Secret 與 VPS 授權設定，不要提交到 Git；Hermes 沒有取得 Docker 權限。

部署後驗收 `/health`、HTTPS 憑證、表單頁與實際 Messenger 表單流程。舊 trycloudflare 通道先保留，直到新網址完成實際驗收；Meta webhook／Messenger 設定不由此 Compose 檔修改。
