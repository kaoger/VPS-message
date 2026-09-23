# 三禾 Messenger 機器人：上線 VPS 待辦清單

- 專案：`kaoger/VPS-message`（Node.js + Express 5，ESM）
- 部署目標：Hostinger VPS，路徑 `/opt/data/projects/sanhe-messenger-bot`，只用 port **3000**
- ⚠️ 不可動到 VPS 上的 Hermes gateway（port **8646**）和它的 tunnel
- ⚠️ 任何 token、密碼、金鑰都不要貼進對話或 commit 進 git，只寫在 VPS 的 `.env`

優先順序：P0 = 上線前必做，P1 = 強烈建議，P2 = 之後再做

## 本機執行狀態（2026-09-23）

- A1–A12 已完成本機程式修正，包含 A11 的共用題庫；下方保留原需求與驗收規格供追溯。
- `npm test` 使用虛構設定及模擬 Meta / Supabase 驗證，不代表真實 Meta、VPS 或資料庫已驗收。
- A5 使用記憶體送出鎖與每 IP 每分鐘 20 次限制；去重只保證單一程序生命週期，重啟會清空。外部服務失敗仍保留 Token 鎖，須人工核對後處理。
- A7 改成只記錄事件名稱，預設 stdout，`LOG_PATH` 選填。A8 由 `INVITE_COOLDOWN_MINUTES` 控制，預設 30 分鐘。
- 部署代理後，需核對實際 IP；只有本機可信單層代理覆寫轉送標頭時才啟用 `TRUST_LOCAL_PROXY=true`。
- B、C、D 仍待實際部署與驗收；文件中「目前設定」屬原始紀錄，尚未重新核對遠端狀態。
- 已追加 webform 的「修改需求」流程：預填、更新原案件、版本衝突防護、過期連結重新索取與「新增需求」指令；僅完成本機模擬驗證。

---

## A. 程式碼修正（在本機完成、測過再推上 GitHub）

### A1 [P0] 正式環境關閉測試端點
- 檔案：`src/server.js`（`/test/reset`、`/test/message`，約第 437–490 行）
- 做法：`NODE_ENV === "production"` 時不要註冊這兩個路由
- 驗收：production 模式下 `POST /test/message` 回 404

### A2 [P0] 驗證 Webhook 簽章
- 檔案：`src/server.js`（`app.use(express.json())`、`POST /webhook`）
- 做法：
  - 用 `express.json({ verify })` 保留 raw body
  - 用 `META_APP_SECRET` 對 raw body 算 HMAC-SHA256，跟 header `X-Hub-Signature-256`（格式 `sha256=...`）用 `crypto.timingSafeEqual` 比對
  - 不符合就回 403，不處理事件
  - `META_APP_SECRET` 沒設定時，production 啟動直接報錯
- 驗收：沒帶簽章或簽章錯誤的 POST 回 403；Meta 傳來的正常事件照常處理

### A3 [P0] 移除寫死的舊 tunnel 網址
- 檔案：`src/server.js`（`sendWebformInvite` 約第 259 行、`/test/message` 約第 474 行），兩處都寫死了 `https://never-donald-biz-respond.trycloudflare.com`
- 做法：統一用 `PUBLIC_BASE_URL`；production 沒設定就啟動失敗
- 驗收：`grep -r trycloudflare src/` 沒有結果

### A4 [P0] 表單 token 密鑰強制設定
- 檔案：`src/form-token.js` 的 `secret()`
- 做法：production 必須設定 `FORM_TOKEN_SECRET`（至少 32 字元），拿掉預設值 `"dev-form-secret-change-me"`，也不要退回用 `META_VERIFY_TOKEN`
- 驗收：production 沒設定時啟動報錯

### A5 [P0] 防止表單重複送出
- 檔案：`src/server.js` 的 `POST /form/submit`
- 做法：
  - 用記憶體 Map 記錄已使用過的 token，保留到 token 過期為止，並定期清理
  - 重複送出時顯示「已送出過」，不要再寫 Supabase，也不要再發 Messenger
  - 加上簡單的 IP 頻率限制（可用 `express-rate-limit`）
- 驗收：同一個 token 送出兩次，Supabase 只有一筆資料

### A6 [P0] Supabase 環境變數名稱對齊
- 檔案：`src/supabase.js`（`getClient`、`isSupabaseConfigured`）
- 做法：金鑰讀 `SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY`
- 驗收：只設定 `SUPABASE_SECRET_KEY` 時，`/health` 顯示 `supabaseConfigured: true`

### A7 [P1] 日誌不要記錄個資
- 檔案：`src/server.js`（`LOG_PATH`、`processWebhook` 的 `webhook_in`）
- 做法：
  - 拿掉訊息原文 `text`
  - `LOG_PATH` 改用環境變數，預設不寫檔，只輸出到 stdout 交給 systemd/journald
  - 錯誤訊息裡不要出現電話或姓名
- 驗收：日誌中搜尋不到測試用的電話號碼

### A8 [P1] webform 模式不要重複發填表邀請
- 檔案：`src/server.js` 的 `processWebhook`（`DEMO_MODE === "webform"` 分支）
- 做法：同一位使用者在 N 分鐘內（例如 30 分鐘，做成環境變數）只邀請一次；剛送出表單的人也不要再邀請
- 驗收：連續傳 3 則訊息，只收到 1 次填表按鈕

### A9 [P1] 文字修正
- `src/form-page.js`：`<title>三合需求快填（Demo）</title>` 改成「三禾需求快填」，拿掉 Demo
- `src/flow.js`：`IS_TEST_BUILD = true` 改為 false，或刪除這個常數

### A10 [P1] Page Access Token 改放 header
- 檔案：`src/meta.js` 的 `sendMessage`
- 做法：不要用 `?access_token=` 放網址，改用 `Authorization: Bearer <token>`
- 驗收：訊息仍然能正常送出

### A11 [P2] 網頁表單改讀 `config/questions.json`
- 檔案：`src/form-schema.js`
- 做法：`FORM_FIELDS` 改從 `flow.js` 載入的設定產生，不再寫死一份，讓 Messenger 和網頁共用同一份題目

### A12 [P1] 更新 `package.json`、`.env.example`、`README.md`
- `package.json`：加上 `"engines": { "node": ">=20" }`
- `.env.example`：列出所有實際會用到的變數，並加註解說明哪些是必填：
  - `NODE_ENV`、`PORT`、`PUBLIC_BASE_URL`
  - `META_VERIFY_TOKEN`、`META_APP_SECRET`、`META_PAGE_ACCESS_TOKEN`
  - `SUPABASE_URL`、`SUPABASE_SECRET_KEY`
  - `DEMO_MODE`、`QUESTIONS_PATH`、`FORM_TOKEN_SECRET`
  - A7、A8 新增的變數
- `README.md`：補上 `DEMO_MODE`（預設 `webform`）的說明和部署步驟

---

## B. Hostinger VPS 部署

### B1 [P0] 環境準備
- 用 SSH 登入 VPS，先確認現有服務（Hermes 8646）的狀態，不要改動它
- 安裝 Node.js 20 LTS 以上（建議用 NodeSource 或 nvm），用 `node -v` 確認
- 確認 port 3000 沒有被占用：`ss -ltnp | grep 3000`

### B2 [P0] 取得程式碼
- `git clone https://github.com/kaoger/VPS-message.git /opt/data/projects/sanhe-messenger-bot`
- repo 如果是私有的，改用 deploy key
- `npm ci --omit=dev`

### B3 [P0] 建立 `.env`
- 參照 `.env.example`，在 VPS 上直接編輯
- 設定 `chmod 600 .env`
- 設定 `NODE_ENV=production`
- 用 `openssl rand -hex 32` 產生 `FORM_TOKEN_SECRET`
- `META_VERIFY_TOKEN` 要和 Meta 後台設定的一致，正式上線使用隨機字串；實際值只保存於環境設定，勿寫入版本控制

### B4 [P0] 用 systemd 常駐執行
- 建立 `/etc/systemd/system/sanhe-messenger-bot.service`：
  - `WorkingDirectory=/opt/data/projects/sanhe-messenger-bot`
  - `ExecStart=/usr/bin/node src/server.js`
  - `EnvironmentFile=` 指向 `.env`
  - `Restart=always`
  - 用非 root 使用者執行
- `systemctl enable --now sanhe-messenger-bot`
- 驗收：`curl http://127.0.0.1:3000/health` 回 `ok: true`；重開機後服務會自動啟動

### B5 [P0] 固定的 HTTPS 對外網址（二選一）
- **選項 1：網域 + nginx + Let's Encrypt**
  - 子網域（例如 `bot.你的網域`）的 A 記錄指向 VPS IP
  - nginx 只反向代理到 `127.0.0.1:3000`
  - 用 certbot 申請憑證
- **選項 2：Cloudflare named tunnel**（需要 Cloudflare 上的網域）
  - 建立新的 tunnel 和 ingress 規則指向 `http://localhost:3000`
  - 不可修改 Hermes 現有的 tunnel 設定
- 不要再用 `trycloudflare.com` 臨時網址，它重開就會換網址
- 完成後，把 `.env` 的 `PUBLIC_BASE_URL` 設為這個固定網址，並重啟服務

### B6 [P1] 防火牆
- `ufw` 只開 22（SSH）、80、443
- 不要對外開 3000
- Hostinger 後台如果有防火牆設定，也要同步調整

### B7 [P2] 更新流程
- 寫一個 `deploy.sh`：`git pull` → `npm ci --omit=dev` → `systemctl restart sanhe-messenger-bot` → `curl /health`

---

## C. Meta 應用程式設定（App ID `2981721165529622`「三禾應用程式」）

- **C1 [P0]** Webhook 回呼網址改成 B5 的固定網址 `https://<固定網域>/webhook`，verify token 要和 `.env` 一致
  - 目前設定：topic `page`，欄位 `messages`
- **C2 [P1]** 如果使用 `DEMO_MODE=chat`（按鈕是 postback），Webhook 要加訂閱 `messaging_postbacks`
- **C3 [P0 正式對外前]** 填寫以下欄位：
  - 隱私權政策網址
  - 資料刪除說明網址
  - 應用程式圖示
  - 類別
- **C4 [P0 正式對外前]** 驗證聯絡信箱 `a25397518@yahoo.com.tw`（目前未驗證）
- **C5 [P0 正式對外前]** App Review 申請 `pages_messaging`，通過後把應用程式從開發模式切換成上線模式
  - 在這之前，只有在應用程式裡有角色的帳號能觸發機器人
- **C6 [P1]** Page Access Token 改用系統使用者產生的長期 token，避免過期

---

## D. 上線驗收

1. `GET https://<固定網域>/health` 回 `ok: true`、`supabaseConfigured: true`
2. Meta 後台 Webhook 驗證通過
3. 用有角色的帳號私訊粉絲專頁 → 收到「開始填表」按鈕 → 填完送出 → Messenger 收到摘要 → Supabase `customer_leads` 多一筆資料
4. 同一個表單連結再送一次 → 不會產生第二筆
5. 不帶簽章 `curl -X POST /webhook` → 回 403
6. `POST /test/message` → 回 404
7. `sudo reboot` 後服務自動恢復
8. `journalctl -u sanhe-messenger-bot` 裡沒有 token 和客戶個資
9. 確認 `customer_leads.answers` 為 jsonb，支援更新時的原資料比對；測試只操作明確標示的測試案件
10. 送出後點「修改需求」→ 上次資料完整帶入（含其他地區）→ 修改電話送出 → 原案件 ID 不變、總筆數不增加、Messenger 收到最新版摘要
11. 同時開啟兩個修改連結；先送出一個，再送出另一個 → 後者提示資料已更新，不能覆蓋新版
12. 30 分鐘內傳「修改需求」仍能取得最近一筆案件的修改連結；傳「新增需求」取得空白表單，送出才建立新案件
13. 修改連結過期時不顯示個資；在 Messenger 重新索取連結後可正常修改。伺服器重啟後，有資料庫且密鑰未變的有效修改連結仍可使用
14. 模擬資料庫失敗 → 不提示修改成功、不新增替代案件；Messenger 傳送失敗 → 網頁保留摘要與修改入口
