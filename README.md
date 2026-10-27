# free-ai-relay

把 [free.ai](https://free.ai/api/) 的 API 包成標準 OpenAI 相容格式的 Cloudflare Worker，讓任何支援 OpenAI API 的工具（SDK、Chat UI、IDE 外掛）都能直接使用。

## 功能

| Relay 路徑 | 對應 free.ai | 轉換 |
|---|---|---|
| `POST /v1/chat/completions` | `POST /v1/chat/` | 原樣轉發，支援 `stream: true` |
| `GET /v1/models` | `GET /v1/models` | 轉成 OpenAI 的 `{"object":"list","data":[...]}`，只列 chat / code 模型 |

- 上游錯誤 `{"error":"..."}` 轉成 OpenAI 的 `{"error":{"message":...}}`
- 支援 CORS，可從瀏覽器直接呼叫
- Relay 不保存任何 key，client 送來的 `Authorization` 直接轉給 free.ai

## 使用

在 OpenAI 相容工具中設定：

- **Base URL**：`https://<你的 worker>.workers.dev/v1`
- **API key**：你的 free.ai key（`sk-free-...`）
- **Model**：例如 `qwen7b`，完整清單見 `GET /v1/models`

```bash
curl https://<你的 worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $FREE_AI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen7b", "messages": [{"role": "user", "content": "Hello!"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="https://<你的 worker>.workers.dev/v1", api_key="sk-free-...")
print(client.chat.completions.create(model="qwen7b", messages=[{"role": "user", "content": "Hello!"}]).choices[0].message.content)
```

## 開發

需要 Node 18+，測試不需安裝任何套件。

```bash
npm test          # node:test，free.ai 在網路邊界以假 fetch 取代
npm run dev       # 本機啟動（wrangler dev）
npm run deploy    # 部署到 Cloudflare
```

部署到自己的帳號前，修改或移除 `wrangler.jsonc` 中的 `account_id`。

## 注意

- free.ai 的自架模型目前不驗證 key，任何知道 relay 網址的人都能使用。
- 免費額度可能以來源 IP 計算，經過 Cloudflare 的請求可能共用限流。
