const UPSTREAM = "https://api.free.ai/v1";
// "*" is safe: auth is a bearer key the caller sends, never a cookie.
const CORS = { "Access-Control-Allow-Origin": "*" };

// Upstream errors are {"error":"msg"} or {"error":{"error":"msg","code":"..."}};
// OpenAI clients expect {"error":{"message":"<string>",...}}.
async function upstreamError(res) {
  const text = await res.text();
  let message = text;
  let code = res.status;
  try {
    const { error } = JSON.parse(text);
    if (typeof error === "string") message = error;
    else if (error) {
      message = error.error ?? error.message ?? JSON.stringify(error);
      code = error.code ?? code;
    }
  } catch {}
  return Response.json(
    { error: { message, type: "upstream_error", code } },
    { status: res.status },
  );
}

// free.ai (vLLM) puts thinking in `reasoning`; many clients read DeepSeek's `reasoning_content`.
function withReasoningContent(body) {
  for (const choice of body.choices ?? []) {
    for (const m of [choice.message, choice.delta]) {
      if (m?.reasoning != null && m.reasoning_content === undefined)
        m.reasoning_content = m.reasoning;
    }
  }
  return body;
}

// Rewrites SSE line by line; events can be split across chunks, so keep the partial last line.
function sseReasoningContent() {
  let partial = "";
  const rewrite = (line) => {
    // Only chunks carrying reasoning need parsing; the rest pass through byte-for-byte.
    if (!line.startsWith("data:") || !line.includes('"reasoning"')) return line;
    try {
      return `data: ${JSON.stringify(withReasoningContent(JSON.parse(line.slice(5))))}`;
    } catch {
      return line;
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) controller.enqueue(rewrite(line) + "\n");
    },
    flush(controller) {
      if (partial) controller.enqueue(rewrite(partial));
    },
  });
}

async function route(request) {
  const { pathname } = new URL(request.url);
  // Pass the client's key through; the relay holds no secret of its own.
  const auth = request.headers.get("Authorization");

  if (request.method === "POST" && pathname === "/v1/chat/completions") {
    const res = await fetch(`${UPSTREAM}/chat/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth && { Authorization: auth }) },
      body: request.body,
    });
    if (!res.ok) return upstreamError(res);
    const type = res.headers.get("Content-Type") ?? "application/json";
    if (type.includes("application/json")) {
      return Response.json(withReasoningContent(await res.json()), { status: res.status });
    }
    const body = type.includes("text/event-stream")
      ? res.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(sseReasoningContent())
          .pipeThrough(new TextEncoderStream())
      : res.body;
    return new Response(body, { status: res.status, headers: { "Content-Type": type } });
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    const res = await fetch(`${UPSTREAM}/models`);
    if (!res.ok) return upstreamError(res);
    const { models } = await res.json();
    return Response.json({
      object: "list",
      data: models
        // Only self-hosted models run on the free allowance; paid ones still work by id.
        .filter((m) => m.self_hosted && (m.type === "chat" || m.type === "code"))
        .map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "free.ai" })),
    });
  }

  return Response.json(
    {
      error: {
        message: `Unknown route: ${request.method} ${pathname}`,
        type: "invalid_request_error",
      },
    },
    { status: 404 },
  );
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    // Every response is built here (never a raw upstream one), so its headers are mutable.
    const res = await route(request);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  },
};
