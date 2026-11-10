/**
 * Server 新建 / 编辑弹窗：别名、传输类型（stdio / Streamable HTTP）、
 * 命令/URL、参数、环境变量、自定义请求头（含鉴权）、超时等。
 */
import { useEffect, useState } from "react";
import { Info, Plus, Trash2 } from "lucide-react";
import * as api from "../api";
import { useAppStore } from "../store";
import type { ServerConfig } from "../types";
import { Modal } from "./ui";

/** 空/新建时的默认配置 */
function defaultConfig(nodeId: number): ServerConfig {
  return {
    node_id: nodeId,
    transport_type: "stdio",
    command: "",
    args: "",
    env: "",
    working_dir: "",
    url: "",
    headers: "",
    timeout_ms: 30_000,
    enabled: true,
    note: "",
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

  // 编辑模式：加载既有配置
  useEffect(() => {
    if (!editNode) return;
    api
      .getServerConfig(editNode.id)
      .then((c) => setCfg(c))
      .finally(() => setLoaded(true));
  }, [editNode]);

  const ready = !editNode || loaded;

  /** 更新配置某字段 */
  const patch = (p: Partial<ServerConfig>) => setCfg((c) => ({ ...c, ...p }));

  /** 提交：新建走 createNode + saveServerConfig；编辑走 renameNode + saveServerConfig */
  const submit = async () => {
    setError("");
    if (!name.trim()) {
      setError("请填写别名");
      return;
    }
    if (cfg.transport_type === "stdio" && !cfg.command?.trim()) {
      setError("stdio 模式必须填写启动命令");
      return;
    }
    if (
      cfg.transport_type === "streamable_http" &&
      !/^https?:\/\//.test(cfg.url?.trim() ?? "")
    ) {
      setError("Streamable HTTP 模式必须填写 http(s):// 开头的服务地址");
      return;
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
          setError(`${label} 不是合法的 JSON：${e}`);
          return;
        }
      }
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
        await reloadNodes();
        void selectNode(node.id);
      }
      await reloadNodes();
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
      footer={
        <>
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
          {/* 别名 */}
          <div>
            <label className="label">别名（显示在资源树中）</label>
            <input
              className="field"
              placeholder="例如：文件系统 / 公司知识库"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* 传输类型 */}
          <div>
            <label className="label">连接方式</label>
            <div className="flex gap-2">
              <Radio
                checked={cfg.transport_type === "stdio"}
                onChange={() => patch({ transport_type: "stdio" })}
                label="stdio（本地子进程）"
                desc="通过命令在本机启动，如 npx / uvx"
              />
              <Radio
                checked={cfg.transport_type === "streamable_http"}
                onChange={() => patch({ transport_type: "streamable_http" })}
                label="Streamable HTTP（远程）"
                desc="连接远程 MCP 服务地址"
              />
            </div>
          </div>

          {cfg.transport_type === "stdio" ? (
            <div className="space-y-3">
              <div>
                <label className="label">启动命令（必填）</label>
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
                valuePlaceholder="值，如 1"
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
                <label className="label">服务地址 URL（必填）</label>
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
                valuePlaceholder="值，如 Bearer sk-****"
              />
            </div>
          )}

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

          {error && (
            <div className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] text-err">
              {error}
            </div>
          )}
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

/** 键值对编辑器属性 */
interface KVProps {
  title: string;
  /** JSON 对象字符串 */
  json: string;
  onChange: (json: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

/** 键值对编辑器：环境变量 / 自定义请求头用，输出 JSON 对象字符串 */
export function KVEditor({ title, json, onChange, keyPlaceholder, valuePlaceholder }: KVProps) {
  /** 解析为行数组（非法 JSON 时显示原文于提示） */
  const rows: Array<[string, string]> = (() => {
    if (!json.trim()) return [];
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      return Object.entries(obj).map(([k, v]) => [k, String(v)]);
    } catch {
      return [];
    }
  })();

  /** 行变化时回写 JSON */
  const writeBack = (next: Array<[string, string]>) => {
    const filtered = next.filter(([k]) => k.trim() !== "");
    onChange(filtered.length === 0 ? "" : JSON.stringify(Object.fromEntries(filtered)));
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="label !mb-0">{title}</label>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-inksoft hover:bg-panel2 hover:text-ink"
          onClick={() => writeBack([...rows, ["", ""]])}
        >
          <Plus size={12} /> 添加
        </button>
      </div>
      <div className="space-y-1.5">
        {rows.length === 0 && (
          <div className="rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-inksoft/70">
            暂无条目，点击「添加」新增。
          </div>
        )}
        {rows.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className="field font-mono !py-1"
              placeholder={keyPlaceholder}
              value={k}
              onChange={(e) => {
                const next = [...rows];
                next[i] = [e.target.value, v];
                writeBack(next);
              }}
            />
            <input
              className="field font-mono !py-1"
              placeholder={valuePlaceholder}
              value={v}
              onChange={(e) => {
                const next = [...rows];
                next[i] = [k, e.target.value];
                writeBack(next);
              }}
            />
            <button
              className="rounded p-1 text-inksoft hover:bg-err/10 hover:text-err"
              title="删除"
              onClick={() => writeBack(rows.filter((_, idx) => idx !== i))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
