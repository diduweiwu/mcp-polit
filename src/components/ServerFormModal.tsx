/**
 * Server 新建 / 编辑弹窗：别名、传输类型（stdio / Streamable HTTP）、
 * 命令/URL、参数、环境变量、自定义请求头（含鉴权）、超时等。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Info } from "lucide-react";
import * as api from "../api";
import { activeEnvName, useAppStore, scheduleSyncExport } from "../store";
import type { ServerConfig } from "../types";
import { siblingNameConflict } from "../lib/tree";
import { parseSensitiveKeys, stringifySensitiveKeys } from "../lib/sensitive";
import { Modal } from "./ui";
import { KVEditor } from "./KVEditor";

/** 空/新建时的默认配置 */
function defaultConfig(nodeId: number): ServerConfig {
  return {
    node_id: nodeId,
    transport_type: "streamable_http",
    command: "",
    args: "",
    env: "",
    working_dir: "",
    url: "",
    headers: "",
    sensitive_headers: "",
    timeout_ms: 30_000,
    enabled: true,
    note: "",
    envs: "",
    active_env: "",
  };
}

/** 弹窗属性 */
interface Props {
  /** 新建时的父目录；null 表示编辑当前选中 server */
  parentId: number | null;
  onClose: () => void;
}

/** Server 表单弹窗 */
export function ServerFormModal({ parentId, onClose }: Props) {
  const { nodes, selectedNodeId, renameNode, reloadNodes, selectNode } =
    useAppStore();
  const environments = useAppStore((s) => s.environments);
  /** 当前激活的全局环境名（顶栏切换；空串 = 未选择环境） */
  const envName = useAppStore((s) => activeEnvName(s));
  /** 该环境的变量名列表（env/headers 值里 {{}} 引用提示条用） */
  const availableVars = useMemo(() => {
    const cur = environments.find((e) => e.name === envName);
    if (!cur?.variables.trim()) return [];
    try {
      return Object.keys(JSON.parse(cur.variables) as Record<string, unknown>);
    } catch {
      return [];
    }
  }, [environments, envName]);

  /** 编辑模式的目标节点（新建时为 null） */
  const editNode =
    parentId == null && selectedNodeId != null
      ? nodes.find((n) => n.id === selectedNodeId) ?? null
      : null;

  const [name, setName] = useState(editNode?.name ?? "");
  const [cfg, setCfg] = useState<ServerConfig>(defaultConfig(editNode?.id ?? 0));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** 连通性测试进行中 */
  const [testing, setTesting] = useState(false);
  /** 连通性测试结果：ok=成功（绿色提示），否则红色错误 */
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 弹窗内容滚动容器：反馈出现在顶部时把视图滚回去，保证看得到 */
  const bodyRef = useRef<HTMLDivElement | null>(null);

  /** 实时重名检查：新建按目标父目录，编辑按节点所在目录（排除自身）。
   *  同步目录是树形镜像布局，同目录同名 Server 会在磁盘上互相覆盖。 */
  const conflictParent = editNode ? editNode.parent_id : parentId;
  const nameConflict = siblingNameConflict(
    nodes,
    conflictParent ?? null,
    name,
    "server",
    editNode?.id,
  );

  /* 保存校验错误 / 连通性测试反馈出现时滚回弹窗顶部（反馈区固定在顶部展示） */
  useEffect(() => {
    if (error || testMsg) bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [error, testMsg]);

  // 编辑模式：加载既有配置
  useEffect(() => {
    if (!editNode) return;
    api
      .getServerConfig(editNode.id)
      .then((c) => setCfg(c))
      .finally(() => setLoaded(true));
  }, [editNode]);

  const ready = !editNode || loaded;

  /** 更新配置某字段（配置变化后旧的测试结果不再可信，一并清除） */
  const patch = (p: Partial<ServerConfig>) => {
    setCfg((c) => ({ ...c, ...p }));
    setTestMsg(null);
  };

  /** 校验配置有效性：返回错误文案，通过时返回空串 */
  const validateConfig = (): string => {
    if (cfg.transport_type === "stdio" && !cfg.command?.trim()) {
      return "stdio 模式必须填写启动命令";
    }
    if (
      cfg.transport_type === "streamable_http" &&
      !/^https?:\/\//.test(cfg.url?.trim() ?? "")
    ) {
      return "Streamable HTTP 模式必须填写 http(s):// 开头的服务地址";
    }
    // JSON 字段预校验，给出友好提示
    for (const [label, raw] of [
      ["参数", cfg.args],
      ["环境变量", cfg.env],
      ["请求头", cfg.headers],
    ] as const) {
      const s = raw?.trim();
      if (s) {
        try {
          JSON.parse(s);
        } catch (e) {
          return `${label} 不是合法的 JSON：${e}`;
        }
      }
    }
    return "";
  };

  /** 测试连通性：用当前表单配置（无需先保存）握手并拉取工具列表（按当前全局环境解析 {{}} 引用） */
  const testConn = async () => {
    const err = validateConfig();
    if (err) {
      setTestMsg({ ok: false, text: err });
      return;
    }
    const projectId = useAppStore.getState().activeProjectId;
    if (projectId == null) {
      setTestMsg({ ok: false, text: "没有已选中的项目，无法测试连通性" });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const tools = await api.testServerConfig(cfg, projectId);
      setTestMsg({ ok: true, text: `连接成功，发现 ${tools.length} 个工具` });
    } catch (e) {
      setTestMsg({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  /** 提交：新建走 createNode + saveServerConfig；编辑走 renameNode + saveServerConfig */
  const submit = async () => {
    setError("");
    if (!name.trim()) {
      setError("请填写别名");
      return;
    }
    if (nameConflict) {
      setError("同目录下已存在同名 Server，请换一个别名");
      return;
    }
    const err = validateConfig();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    try {
      if (editNode) {
        if (editNode.name !== name.trim()) {
          await renameNode(editNode.id, name.trim());
        }
        const saved = { ...cfg, node_id: editNode.id };
        await api.saveServerConfig(saved);
        useAppStore.getState().updateConfigCache(saved);
      } else {
        const node = await api.createNode(
          useAppStore.getState().activeProjectId!,
          parentId,
          "server",
          name.trim(),
        );
        const saved = { ...cfg, node_id: node.id };
        await api.saveServerConfig(saved);
        useAppStore.getState().updateConfigCache(saved);
        await reloadNodes({ keepExpand: true });
        void selectNode(node.id);
      }
      await reloadNodes({ keepExpand: true });
      scheduleSyncExport(); // 实时同步：配置已变更，防抖写盘到同步目录
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={editNode ? `编辑 Server：${editNode.name}` : "新建 Server"}
      onClose={onClose}
      width={640}
      bodyRef={bodyRef}
      footer={
        <>
          <button
            className="btn-ghost mr-auto"
            disabled={testing || saving || !ready}
            onClick={() => void testConn()}
            title="用当前表单配置（无需先保存）尝试握手并拉取工具列表"
          >
            {testing ? "测试中…" : "测试连通性"}
          </button>
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" disabled={saving || !ready} onClick={() => void submit()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </>
      }
    >
      {ready && (
        <div className="space-y-3.5">
          {/* 反馈区（固定在弹窗顶部）：保存校验错误 */}
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] leading-relaxed text-err">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
          {/* 反馈区：连通性测试结果（成功绿 / 失败红） */}
          {testMsg && (
            <div
              className={`flex items-start gap-1.5 rounded-md border px-3 py-2 text-[12px] leading-relaxed break-all ${
                testMsg.ok
                  ? "border-ok/30 bg-ok/10 text-ok"
                  : "border-err/30 bg-err/10 text-err"
              }`}
            >
              <span className="shrink-0">{testMsg.ok ? "✓" : "✗"}</span>
              <span>{testMsg.text}</span>
            </div>
          )}

          {/* 别名 */}
          <div>
            <label className="label">
              别名（显示在资源树中）
              <span className="ml-0.5 text-err" title="必填">*</span>
            </label>
            <input
              className="field"
              placeholder="例如：文件系统 / 公司知识库"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {nameConflict && (
              <p className="mt-1 text-[11.5px] text-err">
                同目录下已存在同名 Server，请换一个别名
              </p>
            )}
          </div>

          {/* 传输类型（HTTP 在前：远程连接是更常用的新建场景） */}
          <div>
            <label className="label">连接方式</label>
            <div className="flex gap-2">
              <Radio
                checked={cfg.transport_type === "streamable_http"}
                onChange={() => patch({ transport_type: "streamable_http" })}
                label="Streamable HTTP（远程）"
                desc="连接远程 MCP 服务地址"
              />
              <Radio
                checked={cfg.transport_type === "stdio"}
                onChange={() => patch({ transport_type: "stdio" })}
                label="stdio（本地子进程）"
                desc="通过命令在本机启动，如 npx / uvx"
              />
            </div>
          </div>

          {cfg.transport_type === "stdio" ? (
            <div className="space-y-3">
              <div>
                <label className="label">
                  启动命令
                  <span className="ml-0.5 text-err" title="必填">*</span>
                </label>
                <input
                  className="field font-mono"
                  placeholder="npx / uvx / node …"
                  value={cfg.command ?? ""}
                  onChange={(e) => patch({ command: e.target.value })}
                />
              </div>
              <div>
                <label className="label">参数（JSON 数组）</label>
                <textarea
                  className="field font-mono"
                  rows={2}
                  placeholder={'例如：["-y","@modelcontextprotocol/server-filesystem","/tmp"]'}
                  value={cfg.args ?? ""}
                  onChange={(e) => patch({ args: e.target.value })}
                />
              </div>
              <KVEditor
                title="环境变量"
                json={cfg.env ?? ""}
                onChange={(v) => patch({ env: v })}
                keyPlaceholder="变量名，如 DEBUG"
                valuePlaceholder="值，如 1，或 {{VAR}} 引用环境变量"
                availableVars={availableVars}
              />
              <div>
                <label className="label">工作目录（可选）</label>
                <input
                  className="field font-mono"
                  placeholder="/path/to/dir"
                  value={cfg.working_dir ?? ""}
                  onChange={(e) => patch({ working_dir: e.target.value })}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="label">
                  服务地址 URL
                  <span className="ml-0.5 text-err" title="必填">*</span>
                </label>
                <input
                  className="field font-mono"
                  placeholder="http://127.0.0.1:3000/mcp"
                  value={cfg.url ?? ""}
                  onChange={(e) => patch({ url: e.target.value })}
                />
              </div>
              <KVEditor
                title="自定义请求头（可放鉴权信息）"
                json={cfg.headers ?? ""}
                onChange={(v) => patch({ headers: v })}
                keyPlaceholder="头名称，如 Authorization"
                valuePlaceholder="值，如 Bearer {{TOKEN}}"
                sensitiveKeys={parseSensitiveKeys(cfg.sensitive_headers)}
                onSensitiveKeysChange={(keys) =>
                  patch({ sensitive_headers: stringifySensitiveKeys(keys) })
                }
                availableVars={availableVars}
              />
            </div>
          )}

          {/* 环境变量引用说明：环境值在顶栏「环境」中管理，这里只做引用 */}
          <div className="flex items-start gap-1.5 rounded-md bg-panel2 p-2.5 text-[12px] leading-relaxed text-inksoft">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              值中可用
              <span className="mx-0.5 font-mono text-primarystrong">{"{{变量名}}"}</span>
              引用环境变量（地址 / 命令 / 参数 / 环境变量 / 请求头均支持），连接时按当前环境
              <b className="mx-0.5">{envName || "（未选择）"}</b>
              替换。变量在顶栏「环境」中定义与修改，与本表单互不影响。
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">调用超时（毫秒）</label>
              <input
                className="field"
                type="number"
                min={1000}
                max={600000}
                step={1000}
                value={cfg.timeout_ms}
                onChange={(e) => patch({ timeout_ms: Number(e.target.value) || 30000 })}
              />
            </div>
            <div>
              <label className="label">启用状态</label>
              <button
                className={`btn-ghost h-[34px] w-full ${cfg.enabled ? "!text-ok" : "!text-inksoft"}`}
                onClick={() => patch({ enabled: !cfg.enabled })}
              >
                {cfg.enabled ? "已启用" : "已停用"}
              </button>
            </div>
          </div>

          <div>
            <label className="label">备注（可选）</label>
            <textarea
              className="field"
              rows={2}
              placeholder="用途说明、负责人等"
              value={cfg.note ?? ""}
              onChange={(e) => patch({ note: e.target.value })}
            />
          </div>

          <div className="flex items-start gap-1.5 rounded-md bg-panel2 p-2.5 text-[12px] leading-relaxed text-inksoft">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              隐私说明：命令、地址、请求头（含鉴权信息）仅保存在本机应用数据目录的
              SQLite 中，MCPilot 不联网上传任何数据。
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 单选卡片 */
function Radio({
  checked,
  onChange,
  label,
  desc,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  desc: string;
}) {
  return (
    <button
      onClick={onChange}
      className={`flex-1 rounded-md border p-2.5 text-left transition-colors ${
        checked
          ? "border-primary bg-primarysoft"
          : "border-line hover:border-inksoft/40 hover:bg-panel2"
      }`}
    >
      <div className={`text-[13px] font-medium ${checked ? "text-primarystrong" : ""}`}>
        {label}
      </div>
      <div className="mt-0.5 text-[11px] text-inksoft">{desc}</div>
    </button>
  );
}
