#!/usr/bin/env node
/**
 * MCPilot 端到端验证用：最小 Streamable HTTP MCP Server（零依赖，纯 Node 实现）。
 *
 * 实现 MCP Streamable HTTP 传输（2025-03-26 规范的最小子集）：
 * - POST /mcp：接收 JSON-RPC；initialize 响应带 Mcp-Session-Id 响应头
 * - 其后请求须携带 Mcp-Session-Id，否则 404（会话不存在）
 * - notifications（无 id）→ 202 Accepted
 * - GET /mcp：返回 405（不支持服务器推送流，客户端可正常工作）
 * - DELETE /mcp：结束会话
 *
 * 工具：upper（文本转大写，带 Authorization 检查：header 正确时返回带标记的结果）
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 3927);
const sessions = new Set();

const tools = [
  {
    name: "upper",
    description: "把输入文本转成大写（验证 HTTP 传输与自定义头）",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要转换的文本" },
      },
      required: ["text"],
    },
  },
];

/** 处理 JSON-RPC，返回 {status, body, session} */
function rpc(msg, sessionId, authHeader) {
  if (!msg || msg.jsonrpc !== "2.0") {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "非法请求" } } };
  }
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize": {
      const sid = "sess-" + Math.random().toString(36).slice(2, 10);
      sessions.add(sid);
      return {
        status: 200,
        session: sid,
        body: {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "mcpilot-test-http", version: "0.1.0" },
          },
        },
      };
    }
    case "notifications/initialized":
      return { status: 202, body: null };
    case "ping":
      return { status: 200, body: { jsonrpc: "2.0", id: msg.id, result: {} } };
    case "tools/list":
      return { status: 200, body: { jsonrpc: "2.0", id: msg.id, result: { tools } } };
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (name === "upper") {
        const marked = authHeader ? `（已带鉴权头）` : ``;
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: `${String(args.text ?? "").toUpperCase()}${marked}` }],
              isError: false,
            },
          },
        };
      }
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `未知工具：${name}` }], isError: true },
        },
      };
    }
    default: {
      if (isNotification) return { status: 202, body: null };
      return {
        status: 200,
        body: { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `方法不存在：${msg.method}` } },
      };
    }
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/mcp") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GET streams not supported" }));
    return;
  }
  if (req.method === "DELETE" && req.url === "/mcp") {
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") sessions.delete(sid);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad json" }));
      return;
    }

    // initialize 之外的方法要求有效会话
    const sid = req.headers["mcp-session-id"];
    if (msg.method !== "initialize" && (typeof sid !== "string" || !sessions.has(sid))) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32001, message: "session not found" } }));
      return;
    }

    const out = rpc(msg, typeof sid === "string" ? sid : undefined, req.headers["authorization"]);
    const headers = { "Content-Type": "application/json" };
    if (out.session) headers["Mcp-Session-Id"] = out.session;
    if (out.status === 202) {
      res.writeHead(202, headers);
      res.end();
      return;
    }
    res.writeHead(out.status, headers);
    res.end(JSON.stringify(out.body));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[http-test-server] listening http://127.0.0.1:${PORT}/mcp`);
});
