# MCPilot — 本地 MCP 调试工作台

MCPilot 是一个跨平台的 [MCP (Model Context Protocol)](https://modelcontextprotocol.io) Inspector 桌面客户端，基于 **Tauri 2 + React 18** 构建。

以「项目 → 目录 → Server」的方式组织你的 MCP Server，提供 **资源树 → 工具列表 → 参数表单 → 调用结果** 四栏工作台。

> **隐私承诺**：全部数据（项目/目录/Server 配置/请求头中的鉴权信息）仅保存在本机应用数据目录的 SQLite 中，应用不接入任何遥测/统计/上报，运行期间除你主动配置的 MCP Server 地址外不发起任何网络请求。

## 功能

- **项目管理**：左上角随时切换项目，数据互相隔离；支持新建 / 重命名 / 删除。
- **目录嵌套**：项目内可建任意层级的目录树，Server 挂在目录下（支持拖拽移动）。
- **Server 别名**：同一命令/地址可在不同位置配置不同别名与凭据。
- **双传输类型**：
  - `stdio` — 本地子进程方式启动（npx / uvx / node …），可配参数、环境变量、工作目录；
  - `Streamable HTTP` — 远程 MCP 服务，支持自定义请求头（Authorization 等鉴权信息）。
- **工具调用**：JSON Schema 自动生成参数表单（含枚举下拉、默认值、必填校验），也可切换 JSON 模式手写；调用带超时保护。
- **结果面板**：JSON 折叠树 / 原始文本切换、耗时统计、结构化内容与入参对照；历史结果仅保留在内存，不落盘。
- **主题**：6 种主色调（默认天蓝）+ 明暗模式，选择持久化。

## 界面

四栏可拖拽分栏：最左为目录与 Server 树（带连接状态点），向右依次为工具列表、参数表单（表单/JSON 双模式）、调用结果。

## 开发

```bash
pnpm install
pnpm tauri dev    # 开发模式
pnpm tauri build  # 打包
```

依赖：Node 18+、pnpm、Rust stable（Tauri 官方要求）。

### 数据存储位置

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/com.mcpilot.app/mcpilot.db` |
| Linux | `~/.local/share/com.mcpilot.app/mcpilot.db` |
| Windows | `%APPDATA%\com.mcpilot.app\mcpilot.db` |

### 内置测试 Server（examples/）

`examples/` 下有两个零依赖的演示 MCP Server，可用于快速上手：

```bash
# Streamable HTTP 演示（端口 3927）
node examples/http-server.mjs
```

- `examples/stdio-server.mjs` — stdio 演示，提供 `echo` / `add` 两个工具；
- `examples/http-server.mjs` — Streamable HTTP 演示，提供 `upper` 工具，会校验 `Authorization` 头。

## 安全说明

- 所有 SQL 使用 prepared statement，防注入；
- 请求头 / 环境变量等敏感值不写日志、不出现在错误信息中（自动脱敏）；
- 已知取舍：敏感配置目前**明文存于本机数据库**（与官方 MCP Inspector 行为一致）；后续可接入操作系统 Keychain 做加密存储；
- Tauri capability 最小化（仅 `core:default`），生产构建启用严格 CSP。
