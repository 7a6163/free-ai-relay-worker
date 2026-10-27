# free-ai-relay

A Cloudflare Worker that exposes the [free.ai](https://free.ai/api/) API in the standard OpenAI-compatible format, so any tool that speaks the OpenAI API (SDKs, chat UIs, IDE plugins) can use it directly.

## Features

| Relay route | free.ai endpoint | Transformation |
|---|---|---|
| `POST /v1/chat/completions` | `POST /v1/chat/` | Forwarded as-is, `stream: true` supported |
| `GET /v1/models` | `GET /v1/models` | Converted to OpenAI's `{"object":"list","data":[...]}`, chat / code models only |

- Thinking models' `reasoning` is also copied to `reasoning_content` (DeepSeek convention), in both normal and streamed responses
- Upstream errors `{"error":"..."}` are converted to OpenAI's `{"error":{"message":...}}`
- CORS enabled, so browsers can call it directly
- The relay stores no keys: the client's `Authorization` header is passed straight through to free.ai

## Usage

Configure your OpenAI-compatible tool with:

- **Base URL**: `https://<your-worker>.workers.dev/v1`
- **API key**: your free.ai key (`sk-free-...`)
- **Model**: e.g. `qwen7b`; see `GET /v1/models` for the full list

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $FREE_AI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen7b", "messages": [{"role": "user", "content": "Hello!"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="https://<your-worker>.workers.dev/v1", api_key="sk-free-...")
print(client.chat.completions.create(model="qwen7b", messages=[{"role": "user", "content": "Hello!"}]).choices[0].message.content)
```

## Development

Requires Node 18+. Tests need no dependencies.

```bash
npm test          # node:test; free.ai is replaced by a fake fetch at the network boundary
npm run dev       # run locally (wrangler dev)
npm run deploy    # deploy to Cloudflare
```

Before deploying to your own account, change or remove `account_id` in `wrangler.jsonc`.

## Caveats

- free.ai's self-hosted models currently don't validate the key, so anyone who knows the relay URL can use it.
- Free-tier limits may be per source IP, so requests through Cloudflare may share rate limits.
