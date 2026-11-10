#!/usr/bin/env node
/**
 * MCPilot 端到端验证用：最小 stdio MCP Server（零依赖，纯 Node 实现）。
 *
 * 实现 MCP stdio 传输（按行分隔的 JSON-RPC 2.0）：
 * - initialize → 返回能力
 * - tools/list → 两个示例工具（echo / add，含默认值与枚举）
 * - tools/call → echo 回显文本；add 计算两数之和
 * - ping → 空结果
 */
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "回显输入的文本（用于验证调用链路）",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要回显的文本" },
      },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "计算两个整数之和",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "integer", description: "第一个数", default: 1 },
        b: { type: "integer", description: "第二个数", default: 2 },
        mode: {
          type: "string",
          description: "输出风格",
          enum: ["plain", "fancy"],
          default: "plain",
        },
      },
      required: ["a", "b"],
    },
  },
];

/** 处理一条 JSON-RPC 请求，返回响应对象（通知返回 null） */
function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return null;
  if (msg.id === undefined || msg.id === null) return null; // 通知：不回复

  const { method, id, params } = msg;
  let result, error;

  switch (method) {
    case "initialize":
      result = {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "mcpilot-test-stdio", version: "0.1.0" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools };
      break;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "echo") {
        result = {
          content: [{ type: "text", text: `收到：${args.text ?? ""}` }],
          isError: false,
        };
      } else if (name === "add") {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
        const text =
          args.mode === "fancy"
            ? `✨ ${args.a} + ${args.b} = ${sum}`
            : String(sum);
        result = { content: [{ type: "text", text }], isError: false };
      } else {
        result = {
          content: [{ type: "text", text: `未知工具：${name}` }],
          isError: true,
        };
      }
      break;
    }
    default:
      error = { code: -32601, message: `方法不存在：${method}` };
  }

  return error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return; // 忽略非 JSON 行
  }
  const resp = handle(msg);
  if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
});

// 向 stderr 写一行标识（MCPilot 不读取 stderr，仅调试用）
process.stderr.write("[stdio-test-server] ready, env DEBUG=" + (process.env.DEBUG ?? "") + "\n");
