import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// Fake free.ai at the network boundary: each test sets `upstream` to the response it wants.
let calls, upstream;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return upstream();
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const chat = (body = { model: "qwen7b", messages: [{ role: "user", content: "hi" }] }) =>
  worker.fetch(
    new Request("https://relay.test/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-test", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("upstream error is returned in OpenAI error format", async () => {
  upstream = () =>
    Response.json(
      { error: "chat queue is currently full. Please retry in a moment.", error_id: "c868a8e2" },
      { status: 503 },
    );

  const res = await chat();

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: {
      message: "chat queue is currently full. Please retry in a moment.",
      type: "upstream_error",
      code: 503,
    },
  });
});

test("non-JSON upstream error keeps the raw text as the message", async () => {
  upstream = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });

  const res = await chat();

  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: { message: "<html>502 Bad Gateway</html>", type: "upstream_error", code: 502 },
  });
});

test("streamed SSE response passes through unchanged", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
  upstream = () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } });

  const res = await chat({
    model: "qwen7b",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  assert.equal(await res.text(), sse);
});

test("chat is forwarded to free.ai /v1/chat/ with the client's key and body", async () => {
  upstream = () => Response.json({ object: "chat.completion", choices: [] });
  const body = { model: "qwen7b", messages: [{ role: "user", content: "hi" }] };

  const res = await chat(body);

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.free.ai/v1/chat/");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(await new Response(calls[0].init.body).json(), body);
});

test("models are listed in OpenAI format, chat and code only", async () => {
  upstream = () =>
    Response.json({
      models: [
        { id: "qwen7b", type: "chat" },
        { id: "qwen-coder", type: "code" },
        { id: "sdxl", type: "image" },
      ],
    });

  const res = await worker.fetch(new Request("https://relay.test/v1/models"));

  assert.equal(calls[0].url, "https://api.free.ai/v1/models");
  assert.deepEqual(await res.json(), {
    object: "list",
    data: [
      { id: "qwen7b", object: "model", created: 0, owned_by: "free.ai" },
      { id: "qwen-coder", object: "model", created: 0, owned_by: "free.ai" },
    ],
  });
});

test("unknown route returns an OpenAI-style 404 without calling upstream", async () => {
  const res = await worker.fetch(
    new Request("https://relay.test/v1/embeddings", { method: "POST" }),
  );

  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.type, "invalid_request_error");
  assert.equal(calls.length, 0);
});

test("models upstream error is returned in OpenAI error format", async () => {
  upstream = () => Response.json({ error: "service unavailable" }, { status: 503 });

  const res = await worker.fetch(new Request("https://relay.test/v1/models"));

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: { message: "service unavailable", type: "upstream_error", code: 503 },
  });
});

test("CORS preflight is answered without calling upstream", async () => {
  const res = await worker.fetch(
    new Request("https://relay.test/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.test",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    }),
  );

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.equal(calls.length, 0);
});

test("every response carries the CORS origin header", async () => {
  upstream = () => Response.json({ object: "chat.completion", choices: [] });
  const ok = await chat();
  upstream = () => Response.json({ error: "busy" }, { status: 503 });
  const failed = await chat();
  upstream = () => Response.json({ models: [] });
  const models = await worker.fetch(new Request("https://relay.test/v1/models"));
  const missing = await worker.fetch(new Request("https://relay.test/nope"));

  for (const res of [ok, failed, models, missing])
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("reasoning is also exposed as reasoning_content", async () => {
  upstream = () =>
    Response.json({
      object: "chat.completion",
      choices: [
        { index: 0, message: { role: "assistant", content: "2", reasoning: "1 plus 1 is 2" } },
      ],
    });

  const { choices } = await (await chat()).json();

  assert.equal(choices[0].message.reasoning, "1 plus 1 is 2");
  assert.equal(choices[0].message.reasoning_content, "1 plus 1 is 2");
});

test("streamed reasoning deltas are also exposed as reasoning_content", async () => {
  const sse =
    'data: {"choices":[{"delta":{"reasoning":"Here"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"2"}}]}\n\n' +
    "data: [DONE]\n\n";
  const enc = new TextEncoder();
  // Split mid-event, as network chunks may.
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(sse.slice(0, 25)));
      c.enqueue(enc.encode(sse.slice(25)));
      c.close();
    },
  });
  upstream = () => new Response(body, { headers: { "Content-Type": "text/event-stream" } });

  const res = await chat({
    model: "deepseek-r1",
    stream: true,
    messages: [{ role: "user", content: "1+1" }],
  });

  assert.equal(
    await res.text(),
    'data: {"choices":[{"delta":{"reasoning":"Here","reasoning_content":"Here"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"2"}}]}\n\n' +
      "data: [DONE]\n\n",
  );
});
