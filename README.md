# sanhe-messenger-bot

固定 8 題 Facebook Messenger 問卷（寫死在 `src/flow.js`）。

**不做：** Supabase 題庫、動態載入、改 LINE／8646／Hermes。

## 流程

1. 服務類型（快選）
2. 地區（快選；「其他地區」→ 再輸入文字）
3. 坪數（快選）
4. 開始時間（快選）
5. 預算（快選）
6. 姓名（文字）
7. 電話（文字，09 開頭 10 碼）
8. 聯絡時段（快選）→ 回摘要

Session：記憶體、30 分鐘 TTL。完成後再傳訊會重頭開始。

## 啟動

```bash
cd /opt/data/projects/sanhe-messenger-bot
# .env: PORT=3000 META_VERIFY_TOKEN=... META_PAGE_ACCESS_TOKEN=...
npm start
```

- Health: `GET /health`
- Webhook verify: `GET /webhook`
- Events: `POST /webhook`（先 200 再處理）
- 本機測流程：`POST /test/reset`、`POST /test/message`

Port **3000 only**。
