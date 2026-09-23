# sanhe-messenger-bot

三禾裝修需求蒐集服務。預設 `DEMO_MODE=webform`：Messenger 私訊 →「開始填表」→ 網頁填寫 → 送出 → Messenger 摘要與選填的 CRM 寫入。`DEMO_MODE=chat` 則使用下方的逐題問答。兩種模式均讀取 `config/questions.json`，可用 `QUESTIONS_PATH` 指定其他設定檔。

**對話中：** 不寫資料庫。  
**確認送出：** 有設定 Supabase 時寫一筆 `customer_leads`；未設定時仍提供摘要，但不保存 CRM 資料。
**不做：** 題庫動態載入、改 LINE／8646／Hermes。

## 流程

1. 服務類型（快選）
2. 地區（快選；「其他地區」→ 再輸入文字）
3. 坪數（快選）
4. 開始時間（快選）
5. 預算（快選）
6. 姓名（文字）
7. 電話（文字，09 開頭 10 碼）
8. 聯絡時段（快選）→ 摘要 → **確認送出／重新填寫**

Session：記憶體、30 分鐘 TTL。

## 啟動

需要 Node.js 20 以上。安裝套件 `npm ci`，參考 `.env.example` 建立本機 `.env`，再執行 `npm start`。請勿提交 `.env`。

正式模式需設定 `NODE_ENV=production`、固定 HTTPS 的 `PUBLIC_BASE_URL`、三項 Meta 設定，以及至少 32 字元的 `FORM_TOKEN_SECRET`，缺少時拒絕啟動。Supabase 優先讀取 `SUPABASE_SECRET_KEY`，亦支援舊的 `SUPABASE_SERVICE_ROLE_KEY`。

- Health: `GET /health`（含 `supabaseConfigured`）
- Webhook verify: `GET /webhook`
- Events: `POST /webhook`（驗證原始內容的 Meta HMAC-SHA256 簽章後，先 200 再處理；所有模式均需簽章）
- 本機測：`POST /test/reset`、`POST /test/message`（production 不註冊）

Port **3000 only**。

## 本機驗證

執行 `npm test`。測試只在本機 3000 埠啟動服務，使用虛構設定與模擬 Meta / Supabase 回應；不讀取 `.env`，不傳送真實訊息或寫入正式資料。若 3000 已被其他程序占用，先確認占用者再處理。

測試涵蓋正式環境必要設定、測試路由關閉、Webhook 簽章、表單驗證、Token 過期／竄改、並行重複提交、API 失敗、邀請冷卻、無資料庫模式與頻率限制。

## 部署與操作

依 `DEPLOY_TODO.md` 的 B–D 執行 VPS、Meta 與實際驗收。只代理 `127.0.0.1:3000`；不要改 Hermes 的 8646 或它的 tunnel。

- 單一 Node 程序以 systemd 管理，啟動命令為 `npm start` 或 `node src/server.js`。
- 表單 Token 預設有效 2 小時。已送出 Token 在到期前鎖定；同時或再次送出回 409，不再重複執行外部操作。
- 送出狀態、邀請冷卻與流量限制存於記憶體，重啟會清空，不支援多程序共享去重。跨重啟／多實例的唯一性需後續資料庫唯一鍵或共享儲存設計。
- 外部 API 失敗時保留送出鎖，避免已執行但回應遺失造成重複。資料庫失敗會顯示 503，請使用者保留摘要並聯繫粉專；不自動重新寫入。
- 每個來源 IP 每分鐘最多 20 次表單送出請求。預設不信任轉送標頭；只有單層本機代理且確實覆寫 `X-Forwarded-For` 時才設 `TRUST_LOCAL_PROXY=true`。否則代理後的使用者可能共用同一額度，須在部署驗收確認。
- 預設 30 分鐘內只發一次邀請，送出表單後重設冷卻。用 `INVITE_COOLDOWN_MINUTES` 調整。
- 日誌僅記錄事件名稱，不記訊息、姓名、電話、使用者識別碼或原始 API 錯誤。預設 stdout；`LOG_PATH` 可選填有效路徑。
- 反向代理的 access log 也應避免記錄 `/form?t=...` 的查詢參數，避免表單連結洩露。
