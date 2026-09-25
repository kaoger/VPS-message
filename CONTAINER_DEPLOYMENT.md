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

## 自動更新

GitHub Actions workflow 與 VPS 限權部署帳號已準備。部署 SSH 私鑰只允許執行 root 擁有的 Bot 更新腳本；Hermes 沒有取得 Docker 權限。首次推送前，需先把本機暫存的私鑰手動存成 GitHub repository secret `SANHE_DEPLOY_KEY`（不可貼進對話或提交到 Git）。

部署後驗收 `/health`、HTTPS 憑證、表單頁與實際 Messenger 表單流程。舊 trycloudflare 通道先保留，直到新網址完成實際驗收；Meta webhook／Messenger 設定不由此 Compose 檔修改。
