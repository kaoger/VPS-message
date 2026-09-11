# sanhe-messenger-bot

固定 8 題 Facebook Messenger 問卷。題目與確認設定在 `config/questions.json`，啟動時載入記憶體；可用 `QUESTIONS_PATH` 指定其他設定檔。

**對話中：** 不寫資料庫。  
**確認送出：** 寫一筆 `customer_leads`（Supabase）。  
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

```bash
cd /opt/data/projects/sanhe-messenger-bot
# .env 需要：
# PORT META_VERIFY_TOKEN META_PAGE_ACCESS_TOKEN
# SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
npm start
```

- Health: `GET /health`（含 `supabaseConfigured`）
- Webhook verify: `GET /webhook`
- Events: `POST /webhook`（先 200 再處理）
- 本機測：`POST /test/reset`、`POST /test/message`

Port **3000 only**。
