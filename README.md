# free-ai-relay

A Cloudflare Worker that exposes the [free.ai](https://free.ai/api/) API in the standard OpenAI-compatible format, so any tool that speaks the OpenAI API (SDKs, chat UIs, IDE plugins) can use it directly.

## Features

| Relay route                 | free.ai endpoint | Transformation                                                                                |
| --------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` | `POST /v1/chat/` | Forwarded as-is, `stream: true` supported                                                     |
| `GET /v1/models`            | `GET /v1/models` | Converted to OpenAI's `{"object":"list","data":[...]}`, lists only `qwen7b` and `deepseek-r1` |

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

## Recommended models

**Free tier:** use `qwen7b`. All self-hosted chat models (`qwen7b`, `qwen-coder`, `mistral`, `qwen3-8b`, ...) are aliases of the same model (`Qwen/Qwen3-30B-A3B-Instruct`). Use `deepseek-r1` to also get the model's thinking in `reasoning_content`.

**With purchased tokens:** any model id from free.ai works, even though `/v1/models` doesn't list it. Cheapest Google options (prices per 1M tokens, October 2026):

| Model                          | Input | Output |
| ------------------------------ | ----- | ------ |
| `google/gemini-2.5-flash-lite` | $0.10 | $0.40  |
| `google/gemini-3.1-flash-lite` | $0.25 | $1.50  |
| `google/gemma-3-4b-it`         | $0.05 | $0.10  |

Models tagged `:free` (e.g. `google/gemma-4-31b-it:free`) still require purchased tokens. Prices change; check `https://api.free.ai/v1/models`.

## Development

Requires Node 24+ (see `.node-version`).

```bash
npm ci
npm test          # node:test; free.ai is replaced by a fake fetch at the network boundary
npm run lint      # oxlint
npm run fmt       # oxfmt (CI runs `npm run fmt:check`)
npm run dev       # run locally (wrangler dev)
npm run deploy    # deploy to Cloudflare
```

If your Cloudflare login has several accounts, pick one with `CLOUDFLARE_ACCOUNT_ID` (e.g. in a git-ignored `.env` file, which Wrangler loads automatically).

## Caveats

- Only self-hosted models run on the free daily allowance; other models (even ones tagged `:free`) need purchased tokens. `/v1/models` lists only `qwen7b` and `deepseek-r1`, but any model id can still be used directly.
- free.ai's self-hosted models currently don't validate the key, so anyone who knows the relay URL can use it.
- Free-tier limits may be per source IP, so requests through Cloudflare may share rate limits.

## License

[MIT](LICENSE)
