# notify-lead

- 來源：`sanhe-crm` Supabase Edge Function 線上版（`notify-lead`）。
- 取得日期：2026-09-27；線上 `updated_at`：2026-09-04T06:52:49.734Z。
- 與取得的線上版差異：`EMAIL_FROM` 必填、改用 `SUPABASE_SECRET_KEYS.default`，以及 Step 2 的搶單、寄信與狀態更新邏輯和 Step 3 的聯絡結果連結。
- 必要環境變數：`SUPABASE_URL`、`SUPABASE_SECRET_KEYS`（平台預設提供）、`RESEND_API_KEY`、`NOTIFICATION_EMAIL`、`EMAIL_FROM`、`WEBHOOK_SECRET`。
- 選用環境變數：`OUTCOME_BASE_URL`（例如 `https://bot.sameheart-design.com`）。未設定時仍照常寄信，不附聯絡結果連結，也不寫入 token 欄位；設定後，每封成功寄出的通知有四個 14 天有效的確認連結。
- 處理流程：驗證 `x-webhook-secret` 後只讀 payload 的 `record.id`。讀取最新列；不存在時短暫重試。只有 `complete` 且 `pending` 的列會用舊 claim id 做 CAS 搶單，寫入 `sending`、`notification_claimed_at` 與新的 `notification_claim_id`。
- 信件使用搶到的最新列；舊 claim id 或 `notified_at` 非 null 時，主旨顯示「已修改」。人工重送（`failed` 改回 `pending`）也會顯示【已修改】，可接受。內文先顯示評分、固定欄位，再顯示原有 `flow_output_fields`。極少數當機情況可能多寄一封內部通知，可接受。
- 寄信後僅持有同一 claim id 的 `sending` 列可標記 `sent` 或 `failed`。有設定 `OUTCOME_BASE_URL` 時，token 雜湊和到期時間與 `sent` 在同一次更新寫入；重寄後舊連結失效。舊寄送者的回寫若已失效，只記錄 `notification_mark_stale`。錯誤與日誌不含客戶資料或金鑰。

## 上線前檢查

1. 確認 Traefik access log 是否開啟、是否記錄完整 query；完整 query 會留下 `/form?t=` 與 `/lead/outcome` 查詢參數中的 `t=` token。若有記錄，設定 query 遮罩或關閉 access log。
2. 確認 Supabase `customer_leads` 已啟用 RLS，且 anon／publishable key 沒有 UPDATE 權限。
3. `OUTCOME_BASE_URL` 必須是 `https://` origin，不含 path、query 或 hash；可有單一結尾 `/`。不合格時照常寄信，但不附聯絡結果連結，也不寫入 token 欄位。

## 部署順序（由使用者或取得同意的 Claude 執行）

1. 依序執行 `ops/lead-scoring.sql`、`ops/notify-states.sql`、`ops/contact-result.sql`。`ops/notify-states.sql` 會刪除所有定義中含 `notification_status` 的 CHECK 約束，**執行前必須先跑檔案開頭的預覽查詢**，確認只有狀態那一條。
2. 部署 `index.ts`、`format.js`、`notify-core.js`；「Verify JWT with legacy secret」保持 OFF（CLI 為 `--no-verify-jwt`）。
3. 後台 webhook `notify-complete-lead` 加勾 Update；用規格 0a 的 SQL 確認只有一個 webhook trigger，事件為 `INSERT,UPDATE`。接著跑 `ops/queries/stuck-notifications.sql`；若有 `notified_at` 不為 null 但停在 `pending` 的舊列（勾 Update 前就被修改過），逐筆執行 `update public.customer_leads set notification_status = 'pending' where id = '<id>';` 觸發一次寄信。
4. FB App Review 通過後部署 VPS 機器人（含 `src/lead-outcome.js` 路由）。舊版機器人在同一句寫入 `pending`，與新函式相容；差別只在 `not_required` 會被重設。

## Rollback

1. webhook 取消勾選 Update。
2. 重新部署 Step 0d 版函式。
3. **必須在第 1 步取消勾選 Update 之後**，才將殘留的 `sending` 列改回 `pending`：

```sql
update public.customer_leads
set notification_status = 'pending'
where notification_status = 'sending';
```
