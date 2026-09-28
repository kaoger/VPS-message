# MVP 規格：內部通知＋評分＋聯絡結果（v2）

> 撰寫：Claude。實作：Codex。反方審查：Grok。決策：使用者。
> v1：2026-09-27 草稿。**v2：2026-09-27 納入 Grok 規格紅隊與 Step 0 查證結果。**
> 狀態：**待使用者確認**。除 Step 0 外，所有部署、資料庫變更、Edge Function 變更，**等 FB App Review 通過後**才上線。

## 0. 一句話

客戶那邊完全不動。客戶送出表單後，系統替這筆需求**打分數**（規則待定，先留位置），寄信通知老闆；信裡有聯絡結果連結，老闆點一下就記下「已聯絡／約丈量／沒興趣／聯絡不上」。

## 1. 情境（驗收時照這個走，用測試資料）

1. 陳先生送出表單：新成屋裝潢、高雄市、31–40 坪、一個月內、100–200 萬、姓名「陳先生（測試）」、電話 0900000000、晚上 6–9 點。
2. Messenger 回他需求摘要（**跟現在逐字相同**）。
3. 1 分鐘內收件人收到**一封**信。
   - 規則未定案：主旨 `新客戶：新成屋裝潢／高雄市／31–40 坪`，內文第一行「評分：尚未設定規則」。
   - 規則定案後（用測試夾具驗證）：主旨 `【🔥 高分】新客戶：…`，內文第一行「評分 10（高分）」＋理由清單。
4. 陳先生修改預算為 200–300 萬 → 再收到**一封**，主旨前加 `【已修改】`，內文的預算為新值。
5. 點信中「約丈量」→ 確認頁 → 按「確認」→ 資料庫 `contact_result = 'site_visit'`。
6. 以上過程**沒有**多寄任何一封信。

## 2. 範圍

**要做**：換掉外洩金鑰、`notify-lead` 進 git、評分骨架、信件顯示評分與「已修改」、修改也寄信、聯絡結果連結。
**不做**：LINE、AI、自動回覆客戶、事件表／Outbox、寄信自動重試、多公司。
**不能動**：客戶看得到的 Messenger 訊息、表單題目、按鈕、文字。

## 3. 現況（已查證）

| 項目 | 事實 | 查證 |
|---|---|---|
| 寄信 | Database Webhook `notify-complete-lead`（AFTER **INSERT** only）→ Edge Function `notify-lead` → Resend | 使用者 SQL＋後台 |
| webhook 標頭 | `Content-type`、`Authorization`（**legacy service_role JWT**）、`x-webhook-secret`（有規則、可猜的字串） | 使用者後台比對 |
| `notify-lead` 條件 | 只處理 `status='complete'` 且 `notification_status='pending'`；成功設 `sent`＋`notified_at`＋`notification_email`；**只有 Resend 失敗才設 `failed`，其他例外停在 `pending` 無提示** | Codex 讀原始碼 |
| `notify-lead` 環境變數 | `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`RESEND_API_KEY`、`NOTIFICATION_EMAIL`、`EMAIL_FROM`、`WEBHOOK_SECRET` | Codex |
| `notify-lead` 原始碼 | 不在 git；第 28 行有寫死的寄件 Email 預設值 | Codex |
| 狀態允許值 | `pending`、`sent`、`failed`、`not_required` | Codex |
| 其他 trigger | `customer_leads_updated_at`（BEFORE UPDATE） | 使用者 SQL |
| `messenger-webhook` | 另一個會建立 Lead 的 Edge Function，是否仍在用**未查證** | — |
| webform 題目 | 固定 8 題（`src/form-schema.js`），不受 `QUESTIONS_PATH` 影響 | Claude |
| 設定檔位置 | 映像內 `/app/config`；compose 另外唯讀掛載 `./config` 到 `/opt/data/projects/sanhe-messenger-bot/config` | Claude |
| 部署 | 推 `main` 會自動重建並重啟 `sanhe-bot` | Grok |

## 4. 共同規則

1. 每步各自驗收，通過才做下一步；每步都要能單獨 rollback。
2. **資料庫欄位一律「先加欄位、後上程式」**；rollback 只還原程式，**不 drop 欄位**。
3. 日誌、錯誤欄位、URL log **不寫**姓名、電話、Messenger ID、token、金鑰。
4. 金鑰只放 VPS `.env` 或 Supabase secrets，不進 git、不貼對話。Claude 不代為輸入任何金鑰。
5. SQL、Edge Function 部署、後台設定屬遠端變更：Codex 只**寫出檔案**，由使用者操作或 Claude 取得同意後執行。
6. **審核期間不推 `main`**（推了就會重啟機器人）。開發在分支進行。
7. 使用者自由輸入的文字（`area_other`、姓名）放進信件或網頁時一律跳脫；放進主旨時移除換行。

---

## Step 0：查清楚＋換金鑰（可在審核期間做，不改客戶流程）

### 0a／0b（已完成）
結果見第 3 節。

### 0c：`messenger-webhook` 是否仍在用
使用者在 Edge Functions → `messenger-webhook` → Invocations 看近 30 天次數。
- 0 次 → Step 0e 一起停用（刪除或加上拒絕所有請求），並記錄在此。
- 大於 0 → 停下來，由 Claude 查來源後再決定。

### 0d：`notify-lead` 進 git
1. Codex 取得線上原始碼，**把第 28 行的寄件預設值改成「沒有 `EMAIL_FROM` 就丟錯」**，其餘一字不改，存到 `supabase/functions/notify-lead/`。
2. README 註明：來源、取得日期、線上 `updated_at`、與線上唯一差異（第 28 行）、需要的環境變數名稱。
3. 部署這份之前，使用者先確認 Supabase secrets 已設 `EMAIL_FROM`。
**驗收**：檔案在 repo、無任何金鑰與 Email、與線上版本只差第 28 行（Codex 附 diff 說明）。

### 0e：換掉外洩的金鑰（使用者操作，Claude 逐步指引）
順序很重要，避免機器人或寄信中斷：
1. 看 VPS `.env` 的 Supabase 伺服器金鑰是 `sb_secret_` 還是 `eyJ` 開頭（只回報種類）。
2. 若是 `eyJ`：建立新的 secret key → 更新 `.env` → 重啟 → 用測試帳號送一次表單，確認寫入正常。
3. 寄信暗號：產生新的隨機 `WEBHOOK_SECRET`（32 bytes 以上）。**在一分鐘內**依序更新 Edge Function secret 與 webhook 標頭；webhook 的 `Authorization` 改成 **anon**（不再用 service_role）。完成後送一筆測試 Lead，確認收到信；再查有沒有卡在 `pending` 的列（見 Step 2 的檢查查詢），有就手動處理。
4. 確認沒有其他地方用 legacy 金鑰（`messenger-webhook`、封存的 CRM 原型）。**`notify-lead` 本身用平台注入的 legacy `SUPABASE_SERVICE_ROLE_KEY` 讀寫資料庫**，停用 legacy 前必須改成 `JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default']`（Supabase 官方文件寫法）並重新部署；部署後確認「Verify JWT with legacy secret」仍為 OFF。

**執行紀錄（2026-09-27）**：1 ✅ VPS 原用 legacy `eyJ`；2 ✅ 新增 `SUPABASE_SECRET_KEY`（名稱仍為 `vps_bot`，是第二把；第一把因值出現在對話中已刪除，兩者開頭不同已比對），測試表單存檔成功；3 ✅ Verify JWT 原本即為 OFF、`WEBHOOK_SECRET` 換成 32 bytes 隨機值、webhook 刪除 `Authorization` 標頭，測試收到信；4 ✅ `messenger-webhook` 無呼叫紀錄（保留未刪）、`notify-lead` 線上版改用 `SUPABASE_SECRET_KEYS.default` 並移除寫死寄件人（與 repo 版本一致），Verify JWT 維持 OFF，測試收到信；5 ✅ 已停用 legacy JWT keys，測試表單存檔與收信皆正常。**Step 0e 完成。**
**後續清理（未做）**：VPS `.env` 的 `SUPABASE_SERVICE_ROLE_KEY` 已失效、可刪除；2026-09-27 的 4 筆測試 Lead（電話為範例號碼）已由使用者依 id 刪除；`messenger-webhook` 是否刪除待決定。
**審核通過後待辦**：Messenger 表單送出後自動返回對話（Meta 網域白名單＋`MESSENGER_WEBVIEW_ENABLED=true`，見 `CONTAINER_DEPLOYMENT.md:18`）。
5. Settings → API Keys 停用 legacy keys（可重新啟用 = rollback）。
**驗收**：機器人寫入正常、通知信正常、舊 service_role 呼叫 API 回 401。
**時機**：挑客戶少的時段；和其他步驟分開做。

---

## Step 1：評分骨架（VPS 機器人）

**上線順序**：先執行 SQL → 再部署程式。

**SQL（`ops/lead-scoring.sql`）**
```sql
alter table public.customer_leads
  add column if not exists lead_score integer,
  add column if not exists lead_grade text check (lead_grade in ('hot','normal','low')),
  add column if not exists lead_score_reasons text[];
```

**新增**
- `src/lead-score.js`：`scoreLead(answers, config) → { score, grade, reasons }`，純函式；`loadScoringConfig()` 每次呼叫時讀檔（檔案很小），讀不到或格式錯就回傳 null 設定。
- `config/lead-scoring.json`：正式設定，**先放空規則**。
- `test/fixtures/lead-scoring.sample.json`：測試夾具（非正式規則）。
- `test/lead-score.test.js`。

**設定檔路徑**：環境變數 `LEAD_SCORING_PATH`；未設定時用 `config/lead-scoring.json`（映像內）。正式環境設為掛載目錄 `/opt/data/projects/sanhe-messenger-bot/config/lead-scoring.json`，**改規則只需改檔＋不用重建映像**。

**設定檔格式（定死，日後只填值）**
```json
{
  "version": 1,
  "fields": {
    "service":  { "新成屋裝潢": 1, "舊屋翻新": 1 },
    "area":     { "高雄市": 2, "台南": 1 },
    "size":     { "31–40 坪": 2 },
    "timeline": { "一個月內": 3 },
    "budget":   { "100–200 萬": 2 }
  },
  "grades": [
    { "grade": "hot",    "min": 8, "label": "🔥 高分" },
    { "grade": "normal", "min": 4, "label": "一般" },
    { "grade": "low",    "min": 0, "label": "低" }
  ]
}
```
規則：
- `fields` 的 key 只能是 `service`、`area`、`size`、`timeline`、`budget`；選項字串必須與 `src/form-schema.js` **完全一致**（含全形破折號）。沒列出的選項 = 0 分。
- `area` 用表單原值（「其他地區」就是「其他地區」，不看自由輸入）。
- `grades` 由高到低，取第一個 `score >= min`；最後一個必須 `min: 0`。
- `reasons` 格式：`"{選項} +{分數}"`，只列大於 0 的項目。
- **空規則**：`{ "version": 1, "fields": {}, "grades": [] }` → 回傳 `{ score: null, grade: null, reasons: null }`。
- 格式錯誤（未知 key、grades 不合規、version 不是 1）→ 同空規則，並記錄事件 `lead_score_config_invalid`。

**修改**：`src/supabase.js` 的 `createCustomerLead`、`updateCustomerLead` 一併寫入三個欄位（聊天模式也走 `createCustomerLead`，一起生效）。沒有 Supabase 的記憶體模式不評分。

**失敗處理**：評分任何錯誤都不影響儲存；三欄寫 null，記錄 `lead_score_fail`。

**測試**：空規則 → 三欄 null；夾具＋陳先生 → 10、`hot`、5 條理由；夾具＋全選「尚未確定」＋其他地區 → 0、`low`、`[]`；格式錯誤 → null 且不丟錯；新增與修改送出的內容都含三欄（mock）；既有測試全過。

**驗收**：`npm test` 全過；客戶摘要逐字不變；情境第 1～2 步正常。
**Rollback**：還原程式；欄位保留。

---

## Step 2：信件顯示評分＋修改也寄信（`notify-lead`）

**SQL（`ops/notify-states.sql`）**：`notification_status` 允許值加入 `sending`；新增 `notification_claimed_at timestamptz`。

**`notify-lead` 處理流程（每次被呼叫）**
1. 驗 `x-webhook-secret`；不符 → 401。
2. 取 payload 的 `record.id`，**原子搶單**：
   先讀列取得舊 `notification_claim_id`，再 CAS：`UPDATE … SET notification_status='sending', notification_claimed_at=now(), notification_claim_id=<新 uuid> WHERE id=$id AND notification_status='pending' AND notification_claim_id IS NOT DISTINCT FROM <舊值> RETURNING *`（實作：`supabase/functions/notify-lead/notify-core.js`）。
   - 0 列 → 回 200、不寄信、**不寫任何欄位**（這會擋住：自己寫 `sent`／`failed` 觸發的呼叫、聯絡結果寫入觸發的呼叫、重複呼叫）。
3. 用搶到的那一列組信（永遠用資料庫最新值，不用 payload 快照）：
   - 主旨：`[【已修改】][【等級】]新客戶：{服務}／{地區}／{坪數}`。`{地區}` 用 `location` 欄；移除換行。
   - `【已修改】`：搶單前已有舊 `notification_claim_id`，或 `notified_at` 不是 null 時加（v2.1）。
   - 內文第一行：有評分 → `評分 {score}（{label}）` ＋理由清單；沒有 → `評分：尚未設定規則`。
   - 其餘內文沿用 `flow_output_fields`；**另外固定列出**服務、地區、坪數、開始時間、預算，確保修改信看得出差異。
   - **不帶** idempotency key（v2.1 決定：會擋掉人工重送；極少數當機情況多寄一封內部信可接受）。
4. 寄信成功 → `UPDATE … SET notification_status='sent', notified_at=now(), notification_email=… WHERE id=$id AND notification_status='sending'`（Step 3 的 token 也在**同一句**寫入）。
5. 寄信失敗或任何例外 → `UPDATE … SET notification_status='failed' WHERE id=$id AND notification_status='sending'`。
6. 第 4／5 步的 UPDATE 另加 `notification_claim_id = <本次 claim id>`，只能回寫自己搶到的那次（v2.1，修正 Grok 指出的誤標）。客戶在寄信途中修改：`updateCustomerLead` 會把狀態改回 `pending`，舊 worker 回寫 0 列（記 `notification_mark_stale`）；該次修改觸發的呼叫會搶到並寄新版。**結果：最多寄兩封（舊版＋新版），不會漏新版。**

**`updateCustomerLead` 修改**：同一句 CAS UPDATE 寫入資料＋`notification_status='pending'`，條件加 `neq not_required`；0 列時再以不含狀態的 CAS UPDATE 重試（處理 `not_required`）。

**後台設定**：webhook `notify-complete-lead` 事件多勾 **Update**。勾完用 0a 的 SQL 再查一次，確認仍然只有一個 webhook trigger、事件為 `INSERT,UPDATE`。

**檢查查詢（`ops/queries/stuck-notifications.sql`）**：列出 `failed`，以及 `pending`／`sending` 且 `updated_at` 超過 10 分鐘的列（只輸出 id、狀態、時間）。每週人工看一次；手動重送 = 把狀態改回 `pending`。

**測試**（正式庫、帶測試標記、收件人先確認為使用者本人）：
1. 新增 → 一封。
2. 修改 → 一封，有 `【已修改】`。
3. 連續兩次快速修改 → 最多兩封，最後一封是最新資料。
4. 手動把一列改成 `sent` → 不寄。
5. 清掉測試資料。

**驗收**：情境第 3、4、6 步成立。
**Rollback**：webhook 取消勾選 Update；重新部署 Step 0d 版本；允許值保留。

---

## Step 3：聯絡結果

**SQL（`ops/contact-result.sql`）**
```sql
alter table public.customer_leads
  add column if not exists contact_result text
    check (contact_result in ('contacted','site_visit','not_interested','unreachable')),
  add column if not exists contact_result_at timestamptz,
  add column if not exists contact_first_at timestamptz,
  add column if not exists outcome_token_hash text,
  add column if not exists outcome_token_expires_at timestamptz;
```

**對照表（畫面文字 ↔ 值）**：已聯絡 = `contacted`、約丈量 = `site_visit`、沒興趣 = `not_interested`、聯絡不上 = `unreachable`。

**流程**
1. `notify-lead` 寄信時產生隨機 token（32 bytes），在 Step 2 第 4 步**同一句**寫入 SHA-256 雜湊與到期時間（寄出後 14 天）。信中 4 個連結：`https://bot.sameheart-design.com/lead/outcome?id={id}&t={token}&r={值}`。
2. VPS 新增 `src/lead-outcome.js`，由 `src/server.js` 掛上：
   - `GET /lead/outcome`：token 正確且未過期 → 確認頁，只顯示「要記錄的結果」與「確認」按鈕，**不顯示任何客戶資料**（信箱掃描器會開這個網址）。**不寫資料庫。**
   - `POST /lead/outcome`：token 正確且未過期 → 寫入 `contact_result`、`contact_result_at`；`contact_first_at` 只在第一次寫入。可重複改，以最後一次為準。
   - 寫入**只更新這三欄**，不可呼叫 `updateCustomerLead`，不可改 `notification_status`。
   - token 錯、過期、查無 id → 一律相同的「連結無效或已過期」頁、相同 HTTP 狀態（404）。
   - 限流：這兩個路由獨立一個桶（不要和 `/form/submit` 共用），每 IP 每分鐘 30 次。
3. Log 遮罩：`/lead/outcome` 的 query string 不得出現在任何 log（比照 `/form?t=` 的處理）。
4. 修改後重寄信 → 產生新 token，舊連結失效（可接受：老闆用最新那封）。

**測試**（`test/lead-outcome.test.js`）：GET 不寫入且不含客戶資料；正確 token POST 寫入；錯誤／過期／查無 id 回應完全相同；非法 `r` 拒絕；`contact_first_at` 只寫一次；POST 不改 `notification_status`；log 不含 token。

**驗收**：情境第 5 步成立；Gmail 手機版實際點一次；確認頁被預覽不會寫入；寫入聯絡結果後**沒有**多寄信。
**Rollback**：移除路由；`notify-lead` 退回 Step 2 版本；欄位保留。

---

## Step 4：自己用 1～2 個月，看數字

`ops/queries/mvp-metrics.sql`（只輸出統計）：
1. 送出（`completed_at`）到第一次記錄結果（`contact_first_at`）的平均時間，依等級分組。
2. 各等級「約丈量」比例。
3. 超過 3 天沒有聯絡結果的筆數。

**決策點**：數字支持才進入下一階段（LINE 通知、AI 分析、商業化）。

## 5. 使用者決定紀錄

1. 評分規則：**等使用者與三禾確認後提供**，只填 `lead-scoring.json`。（2026-09-27）
2. 修改需求也要通知。（2026-09-27）
3. 收件信箱：MVP 期間寄給使用者本人；地址只設定在 Supabase secrets，不進 repo。目前線上收件人未查證，Step 2 測試前確認。（2026-09-27）
4. 金鑰輪替時間：待定（Step 0e）。

## 6. Grok 紅隊（v1）採納紀錄

採納：寄信搶單與 `sending` 狀態、token 與 `sent` 同句寫入、`not_required` 不重設、聯絡結果不觸發寄信、token 到期與 log 遮罩、無效連結回應一致、獨立限流、SQL 先於程式、評分設定檔格式與路徑、情境補齊必填欄位、主旨地區用 `location`、卡住通知的檢查查詢、0d 第 28 行處理、0e 順序與 anon 取代 service_role、`messenger-webhook` 處置、審核期間不推 `main`。
未採納：一次性 nonce／操作者紀錄（單人使用，最後一次為準即可）；新舊 `WEBHOOK_SECRET` 並存期（改以一分鐘內更新＋事後檢查 `pending` 處理）。
v2.1（Step 2 Grok 兩輪紅隊）：改用 claim id 回寫、移除 idempotency key、修改改回一步寫入、SQL 包交易、卡住查詢改看 `notification_claimed_at`。
待查：`set_customer_leads_updated_at` 是否只改 `NEW.updated_at`；webhook 對非 200 是否重送。
