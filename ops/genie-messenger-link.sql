-- Genie-Local 客戶卡片的 Messenger 一鍵對話：允許成員讀取客戶的 Messenger 使用者 ID。
-- 前提：已執行 ops/genie-access.sql。
-- Rollback：revoke select (messenger_user_id) on table public.customer_leads from authenticated;
begin;

grant select (messenger_user_id) on table public.customer_leads to authenticated;
notify pgrst, 'reload schema';

commit;
