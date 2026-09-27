# notify-lead 原始碼備份

- 來源：`sanhe-crm` Supabase Edge Function 線上版（`notify-lead`）。
- 取得日期：2026-09-27；線上 `updated_at`：2026-09-04T06:52:49.734Z。
- 與線上版差異：
  - `index.ts` 第 28 行：`EMAIL_FROM` 必填，未設定或為空時丟錯。
  - `supabaseAdmin` 改用 `SUPABASE_SECRET_KEYS.default`。
- 必要環境變數：`SUPABASE_URL`、`SUPABASE_SECRET_KEYS`（平台預設提供）、`RESEND_API_KEY`、`NOTIFICATION_EMAIL`、`EMAIL_FROM`、`WEBHOOK_SECRET`。
- 部署時必須保持「Verify JWT with legacy secret」＝OFF（CLI 為 `--no-verify-jwt`）。
- 處理條件：`x-webhook-secret` 必須符合設定；payload 的 `record` 須存在，且 `status='complete'`、`notification_status='pending'`，否則略過。
- 寄送成功：更新 `notification_status='sent'`、`notification_email`、`notified_at`。
- Resend 回應失敗：嘗試更新 `notification_status='failed'`。非 Resend 例外不會更新通知狀態，可能停在 `pending`。
