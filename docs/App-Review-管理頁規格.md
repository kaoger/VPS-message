# Messenger 管理頁（App Review 重送用）— 規格（定稿候選，待使用者確認範圍）

## 0. 背景與目標
- 2026-10-11 Meta App Review 第 1 次送審被退：`pages_messaging`、`pages_manage_metadata`、`pages_show_list`、`business_management` 四項全退，理由相同——**螢幕錄影沒有展示端對端使用案例**。Meta 同時寫「我們決定允許您的應用程式使用案例」，用途本身被接受。
- 審核人員備註（pages_messaging）：錄影要看到 (1) 選資產（粉絲專頁可見）(2) 從**我們的 App** 按送出 (3) 同一則訊息出現在 Messenger 原生 App。其餘三項：要看到完整 Meta 登入、使用者同意權限、權限的使用過程；介面建議英文；伺服器對伺服器／系統用戶權杖的部分在備註說明即可。
- 上次錄影的問題：訊息都是機器人自動回覆，沒有「在 App 裡按送出」；另外三項是在 Graph API 測試工具（Meta 的工具，不算我們的 App）操作。
- 使用者 2026-10-12 決定：**做法 A**——在 `bot.sameheart-design.com` 做一個簡單的管理頁，一支影片涵蓋四項權限。
- 目標：管理員用 Facebook 登入 → 同意四項權限 → 看到企業管理平台與粉絲專頁 → 選粉絲專頁 → 確認／訂閱 Webhook → 選一位近期私訊的客人 → 輸入並送出回覆 → 客人在 Messenger 收到。
- 範圍外：給客人用的任何新功能、改現有機器人自動回覆流程、把管理頁接進 Genie 工作台、存任何權杖或訊息到資料庫、群發或主動推播。

## 1. 原則
- 機器人日常運作**不改**：Webhook、填表、通知信照舊，仍用系統用戶權杖（`META_PAGE_ACCESS_TOKEN`）。
- 管理頁只用**登入者本人授權**取得的權杖，只放在伺服器記憶體、有時效，不寫資料庫、不寫 log、不出現在網址或前端。
- 只回覆 24 小時訊息時效內、主動私訊過粉絲專頁的人；`messaging_type: RESPONSE`；不提供群發、不提供標籤訊息。
- 只允許指定的管理員使用（允許清單），其他人登入後一律拒絕並丟棄權杖。
- 介面英文（Meta 錄影建議）；必要處附一行中文小字可以，但按鈕與標題以英文為主。
- repo 公開：App Secret、權杖、管理員 ID 只放 `.env`，範例檔用佔位字。

## 2. 流程與畫面（路徑掛在現有 Express，`/admin` 開頭）
1. `GET /admin`：未登入顯示說明＋「Continue with Facebook」按鈕。
2. `GET /admin/login`：產生 `state`（防 CSRF，綁 HttpOnly cookie），導向 Facebook 登入／授權頁，scope＝四項權限（登入方式見 §7 Q1）。
3. `GET /admin/callback`：驗 `state` → 伺服器用 App Secret 換權杖 → 取 `/me` → 不在允許清單就 403 並丟棄 → 建立伺服器端 session（隨機 id、HttpOnly＋Secure＋SameSite=Lax cookie、閒置 30 分鐘／最長 2 小時）。
4. **Step 1 Business（business_management）**：`GET /me/businesses` 顯示企業管理平台名稱；再顯示該平台擁有的粉絲專頁（`/{business-id}/owned_pages` 或等效）。
5. **Step 2 Select Page（pages_show_list）**：`GET /me/accounts` 列出可管理的粉絲專頁，單選；只有三禾 Page ID 可選（其他顯示 not supported）。選定後從回應取得粉絲專頁權杖，只存在 session。
6. **Step 3 Webhook（pages_manage_metadata）**：`GET /{page-id}/subscribed_apps` 顯示本 App 是否已訂閱與欄位；按「Subscribe」才 `POST subscribed_apps`（欄位至少涵蓋現有的，**不可移除現有欄位**）。已訂閱則只顯示狀態。
7. **Step 4 Reply（pages_messaging）**：列出近期對話（客人名稱或代稱、最後訊息時間、是否仍在 24 小時內），選一位 → 文字框（≤ 2000 字）→「Send」→ 伺服器呼叫 Send API → 顯示成功與時間；超過 24 小時的對話按鈕停用並說明原因。對話來源見 §7 Q2。
8. `POST /admin/logout`：刪 session、清 cookie。
- 所有 POST 需 session＋CSRF token；所有輸出經跳脫；Graph 呼叫一律加 `appsecret_proof`；錯誤只顯示通用訊息＋Meta 錯誤代碼，不回傳原始錯誤內容。
- 速率限制：登入、送訊息各自限流（例如每 session 每分鐘 10 次送出）。

## 3. 設定（新 `.env` 鍵，範例檔佔位）
- `META_APP_ID`（公開值可放範例說明）、既有 `META_APP_SECRET` 共用。
- `ADMIN_FB_USER_IDS`：允許清單（本 App 範圍的使用者 ID，逗號分隔）。
- `ADMIN_SESSION_SECRET`：≥32 bytes 隨機，用於 cookie 簽章與 state。
- `ADMIN_ALLOWED_PAGE_ID`：三禾 Page ID。
- 缺任一鍵：`/admin` 回 503「Admin console not configured」，不影響機器人其他功能。

## 4. 使用者要在 Meta 後台做的事（Claude 會一步一步帶）
- 加入登入產品（Facebook Login 或 Facebook Login for Business，見 §7 Q1），設定有效的 OAuth 重新導向 URI `https://bot.sameheart-design.com/admin/callback`、App 網域。
- 確認錄影用的兩個帳號：管理員帳號（有 App 角色、管理粉絲專頁）、客人帳號（測試人員或家人，用手機 Messenger 先私訊粉絲專頁）。
- App 維持開發模式，**審核通過前不按「發佈」**。

## 5. 錄影與重送（程式上線後）
- 一支影片（1080p、無聲、英文字幕），Facebook 介面切英文：客人帳號先私訊粉絲專頁 → 管理員開 `/admin` → 登入與同意四項權限 → Business → 選 Page → Webhook 狀態 → 選該客人 → 送出 → 切到客人手機 Messenger 看到同一則訊息。
- 另附一段客人端機器人填表流程（沿用上次腳本）可選。
- 重送備註：說明伺服器自動回覆使用系統用戶權杖（伺服器對伺服器，無前端登入）；管理頁使用 Facebook 登入。更新 `APP_REVIEW_SUBMISSION.md` 的四段說明與審核人員測試說明，讓文字與影片一致。
- API 呼叫紀錄 10/26 到期：管理頁實際使用即會重新呼叫四項權限；若重送晚於 10/26，送審前再操作一次管理頁。

## 6. 驗收
- `node --test`：OAuth state 錯誤／過期拒絕；非允許清單 403 且不保留權杖；session 過期；CSRF；只允許三禾 Page；24 小時外拒絕送出；Graph 回錯誤時不洩漏權杖；log 不含權杖與訊息內容；缺設定回 503；既有測試全過。Graph API 用假的 fetch。
- 本機手動：用假 Graph 伺服器跑完整畫面流程。
- 上線後 Claude 冒煙：`/health` 正常、機器人自動回覆與填表正常、`/admin` 未登入只看到登入按鈕。
- 使用者實測：管理員帳號登入 → 送一則訊息到測試客人 → 手機 Messenger 收到。

## 7. 討論題（請正反方表態）
1. 登入方式：一般 Facebook Login（`scope` 參數）還是 Facebook Login for Business（`config_id`、可用系統用戶權杖類型）？本 App 類型是 Business。哪一種的同意畫面能清楚顯示四項權限、最符合審核人員要看的「登入＋同意」？
2. 近期對話來源：Graph `/{page-id}/conversations`（需要哪些權限？會不會因此多送審一項）還是機器人 Webhook 收到訊息時記錄「最後來訊時間」（記憶體或資料庫）？
3. 允許清單：用 App 範圍使用者 ID、還是檢查該使用者在粉絲專頁有 MESSAGING 任務／在 App 有角色？
4. session 存放：記憶體（單一容器，重啟即登出）是否足夠？
5. 審核通過後管理頁要保留成正式工具（回覆客人）還是關閉？Meta 是否要求功能持續存在？
6. `POST subscribed_apps` 會不會改掉現有訂閱欄位、讓機器人收不到訊息？要怎麼保護。
7. 本機 `D:\Desktop\三禾聊天機器人` 與 VPS 上執行中的版本是否一致；上線方式（推 GitHub main → VPS 拉＋重建容器）有無風險。

## 8. 預估
Codex 實作＋測試約 1–1.5 天；Meta 後台設定 30 分鐘（使用者）；錄影半天；重送 30 分鐘。

## 9. 討論結果（2026-10-12，Codex 正方＋Grok 反方，Claude 裁決）
以下優先於 §2–§7 的草稿內容。
1. 登入：**Facebook Login for Business**、`config_id`（新 `.env` 鍵 `META_LOGIN_CONFIG_ID`）、權杖類型 **User access token**、資產選 Pages。不用系統用戶權杖類型。錄影前要確保同意畫面會出現（首次授權的帳號，或 `auth_type=rerequest`）；**不可**為了重現同意畫面去移除正式的企業整合、撤銷系統權杖或重設 App Secret。
2. 近期客人：**不用** `/{page-id}/conversations`（會多一項 `pages_read_engagement`）。改在 Webhook 驗簽後記錄 `{pageId, psid, lastInboundAt}`（記憶體、容量上限、只記指定 Page 的非 echo 來訊、用 `event.timestamp`、拒絕未來時間、亂序取最大值；觀察要在各 `continue` 分支之前，失敗不影響機器人）。畫面用代稱，不取姓名、不存訊息內容。重啟即清空。
3. 送出：用 **session 內登入者取得的三禾 Page token** 呼叫 `/{page-id}/messages`、`messaging_type: RESPONSE`；**不可**用 `meta.sendText()`／`META_PAGE_ACCESS_TOKEN`。前端只送伺服器核發的收件人代碼，伺服器再映射 PSID 並重驗 24 小時；一次性操作 ID 防重送；timeout 顯示「結果未確認」不自動重試；成功顯示 Meta 回的 message_id 與時間。
4. Webhook 訂閱（Claude 裁決）：預設只顯示 `GET subscribed_apps` 狀態；「Confirm subscription」按鈕＝讀現有欄位 → 與必要欄位（`messages`、`messaging_postbacks`）取**聯集** → POST → 再 GET 核對，不一致顯示警告。永不移除欄位、不提供取消訂閱。
5. 允許清單：App 範圍使用者 ID（字串比對）**且**該使用者對三禾 Page 有 MESSAGING 任務；另限制 Business ID（新鍵 `ADMIN_ALLOWED_BUSINESS_ID`，可選）。不在清單時 403 頁面顯示「請把此 ID 交給管理員：<app-scoped id>」以便設定，並丟棄權杖。
6. 設定：`ADMIN_*`、`META_LOGIN_CONFIG_ID`、`META_APP_ID` **不可**加進 `validateEnvironment()`；缺鍵只讓 `/admin` 回 503。
7. 安全細節：state 32 bytes、5 分鐘、單次使用；登入成功換新 session id；cookie `HttpOnly; Secure; SameSite=Lax; Path=/admin`；所有 POST 驗 session＋CSRF（固定時間比較）＋同源 Origin；`/admin` 專用 CSP（`default-src 'none'`、`form-action 'self'`、`frame-ancestors 'none'`，盡量不用前端 JS）；每次 Graph 呼叫用該次權杖算 `appsecret_proof`、權杖放 Authorization header、10 秒 timeout；不跟隨 `paging.next`；log 只記事件名與錯誤代碼。**不要**在 Meta 後台開啟全 App 強制 `appsecret_proof`（現有機器人沒帶）。
8. 代理：現有 `trust proxy` 只信 loopback、實際是 Traefik 跨容器；實作需核對真實代理來源再設定，不可改成無條件信任。
9. 審核帳號（使用者 2026-10-12 決定）：使用者自行註冊一個**審核專用 Facebook 帳號**，加為 App 測試人員＋三禾 Page 的訊息管理任務＋管理頁允許清單；帳密只填 Meta 審核的私密欄位；審核結束後移除權限。
10. 審核通過後：管理頁保留為受限正式工具。
11. 文件同步：重寫 `APP_REVIEW_SUBMISSION.md`（刪 “No login is required”，分「客人免登入、管理員須登入」，四段說明對應管理頁步驟，備註寫伺服器自動回覆用系統用戶權杖）、`RECORDING_SCRIPT.md`（影片字幕標 Step1 Business／Step2 Page／Step3 Webhook／Step4 Send，送出唯一英文句子再切到手機 Messenger）、隱私權政策補管理員登入資料與 session cookie。
12. 部署：推 main 會自動測試並部署；部署前核對 VPS 執行版本與要部署的 commit 一致，只動 `sanhe-bot` 容器，不碰 Hermes 8646／tunnel，保留回復方式。
13. 預估改為：實作＋測試 2–3 個工作天；錄影＋文件＋重送半天到 1 天。
