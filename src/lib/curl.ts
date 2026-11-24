/**
 * 把一次 MCP 工具调用转写为等价的 cURL 命令，便于在终端直接调试 Streamable HTTP server。
 *
 * 仅 Streamable HTTP 传输可生成（stdio 是本地子进程，没有 HTTP 端点可 curl）；
 * 生成的是「单次 tools/call POST」形态，适用于 stateless 模式的 server；
 * 有会话校验的 server 需先 initialize 拿到 Mcp-Session-Id，再手动补到命令里。
 */

/** curl 生成所需的 server 连接信息（取自 ServerConfig 的 http 字段） */
export interface CurlTarget {
  /** 服务地址（MCP endpoint，如 http://127.0.0.1:3927/mcp） */
  url: string | null;
  /** 自定义请求头：JSON 对象字符串；缺失/损坏按无自定义头处理 */
  headers?: string | null;
}

/**
 * shell 单引号转义：POSIX shell 中单引号内无转义符，用 `'\''` 拼接闭合表达。
 *
 * @example
 * shellQuote("it's"); // => "'it'\\''s'"
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 解析配置里的请求头 JSON（对象形态）；损坏/非对象返回空表，不中断生成。
 *
 * @example
 * parseHeaders('{"Authorization":"Bearer t"}'); // => [["Authorization","Bearer t"]]
 */
function parseHeaders(headersJson?: string | null): Array<[string, string]> {
  const s = headersJson?.trim();
  if (!s) return [];
  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    return Object.entries(obj).map(([k, v]) => [k, String(v)]);
  } catch {
    return [];
  }
}

/**
 * 生成调用工具的 cURL 命令文本。
 *
 * 输出形态：`curl -X POST '<url>' -H ... -d '<JSON-RPC tools/call>'`，
 * 每个参数独立一行（`\` 续行），直接可粘贴到终端执行。
 * 请求头使用配置里的**真实值**（含鉴权头明文，否则 curl 无法调试通过），
 * 复制后请注意不要粘贴到不可信的场合。
 *
 * @param target server 连接信息（url + 自定义 headers）
 * @param toolName 工具名
 * @param argumentsJson 入参 JSON 字符串；损坏时按 `{}` 兜底
 * @returns 多行 cURL 命令；url 缺失（stdio / 未配置）返回 null
 *
 * @example
 * buildToolsCallCurl({ url: "http://127.0.0.1:3927/mcp", headers: "{}" }, "upper", '{"text":"a"}');
 * // => "curl -X POST 'http://127.0.0.1:3927/mcp' \\\n  -H 'Content-Type: ...' \\\n  -d '...'"
 */
export function buildToolsCallCurl(
  target: CurlTarget,
  toolName: string,
  argumentsJson: string,
): string | null {
  const url = target.url?.trim();
  if (!url) return null;

  // 入参尽量保持调用时的真实形态；损坏 JSON 兜底为空对象，不让复制动作失败
  let args: unknown = {};
  try {
    const parsed = JSON.parse(argumentsJson);
    args = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    /* 保持空对象 */
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const lines: string[] = [`curl -X POST ${shellQuote(url)}`];
  // Streamable HTTP 要求同时接受普通 JSON 与 SSE 两种响应形态
  lines.push("  -H 'Content-Type: application/json'");
  lines.push("  -H 'Accept: application/json, text/event-stream'");
  for (const [k, v] of parseHeaders(target.headers)) {
    lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  }
  lines.push(`  -d ${shellQuote(body)}`);
  return lines.join(" \\\n");
}
