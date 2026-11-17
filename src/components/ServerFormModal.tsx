/**
 * Server 新建 / 编辑弹窗：别名、传输类型（stdio / Streamable HTTP）、
 * 命令/URL、参数、环境变量、自定义请求头（含鉴权）、超时等。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Info, Plus, Trash2, X } from "lucide-react";
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

          {/* 环境组：多套 env/headers 覆盖，连接时按激活环境套用 */}
          <EnvSection cfg={cfg} patch={patch} />

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
  /** 从 JSON 解析出键值行（非法 JSON 时显示为空，合法性由父级提交校验提示） */
  const parsed: Array<[string, string]> = useMemo(() => {
    if (!json.trim()) return [];
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      return Object.entries(obj).map(([k, v]) => [k, String(v)]);
    } catch {
      return [];
    }
  }, [json]);

  /**
   * 草稿行：承载「已添加但 key 尚未填写」的空行。
   * 空行不能写回 JSON（写回时必须过滤空 key），而展示行又由 json 派生，
   * 纯受控会让空行刚加上就消失——故用本地草稿保存，外部 json 变化时丢弃。
   */
  const [draft, setDraft] = useState<Array<[string, string]> | null>(null);
  /** 最近一次本组件写出的 JSON；用于区分自身写回与外部变化（避免误清草稿） */
  const lastWritten = useRef<string | null>(null);

  useEffect(() => {
    if (lastWritten.current !== null && lastWritten.current === json) return;
    lastWritten.current = null;
    setDraft(null);
  }, [json]);

  /** 展示行：优先草稿（含待填写的空行），否则为 JSON 解析结果 */
  const rows = draft ?? parsed;

  /** 行变化：有效行写回 JSON；含空 key 行时保留在草稿中供继续填写 */
  const setRows = (next: Array<[string, string]>) => {
    const valid = next.filter(([k]) => k.trim() !== "");
    const out = valid.length === 0 ? "" : JSON.stringify(Object.fromEntries(valid));
    lastWritten.current = out;
    onChange(out);
    setDraft(next.some(([k]) => k.trim() === "") ? next : null);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="label !mb-0">{title}</label>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-inksoft hover:bg-panel2 hover:text-ink"
          onClick={() => setRows([...rows, ["", ""]])}
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
                setRows(next);
              }}
            />
            <input
              className="field font-mono !py-1"
              placeholder={valuePlaceholder}
              value={v}
              onChange={(e) => {
                const next = [...rows];
                next[i] = [k, e.target.value];
                setRows(next);
              }}
            />
            <button
              className="rounded p-1 text-inksoft hover:bg-err/10 hover:text-err"
              title="删除"
              onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 环境组结构（envs JSON 的单个条目） */
interface EnvGroup {
  env: string;
  headers: string;
}

/**
 * 环境组管理：为 server 定义多套 env/headers 覆盖（如 dev / prod），
 * 支持从 Base、本 server 其他环境或其他 server 的环境 clone。
 * 激活某环境后（资源树/摘要面板切换），连接时会覆盖同名的 Base 项。
 */
function EnvSection({
  cfg,
  patch,
}: {
  cfg: ServerConfig;
  patch: (p: Partial<ServerConfig>) => void;
}) {
  const nodes = useAppStore((s) => s.nodes);
  const serverConfigs = useAppStore((s) => s.serverConfigs);
  const [selected, setSelected] = useState("__base");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [cloneFrom, setCloneFrom] = useState("__none");

  /** envs JSON -> 内存 Map */
  const envMap: Record<string, EnvGroup> = useMemo(() => {
    try {
      return JSON.parse(cfg.envs ?? "{}") as Record<string, EnvGroup>;
    } catch {
      return {};
    }
  }, [cfg.envs]);
  const names = Object.keys(envMap);

  /** 其他 server 的可用环境（clone 来源）：base + 各环境 */
  const foreignEnvs = useMemo(() => {
    const list: Array<{ label: string; env: string; headers: string }> = [];
    for (const n of nodes) {
      if (n.node_type !== "server" || n.id === cfg.node_id) continue;
      const c = serverConfigs[n.id];
      if (!c) continue;
      list.push({
        label: `${n.name} · Base`,
        env: c.env ?? "",
        headers: c.headers ?? "",
      });
      if (!c.envs) continue;
      try {
        const m = JSON.parse(c.envs) as Record<string, EnvGroup>;
        for (const [name, g] of Object.entries(m)) {
          list.push({ label: `${n.name} · ${name}`, env: g.env, headers: g.headers });
        }
      } catch {
        /* 忽略坏数据 */
      }
    }
    return list;
  }, [nodes, serverConfigs, cfg.node_id]);

  /** 写回 envs JSON（空 Map 时清空字段） */
  const writeMap = (map: Record<string, EnvGroup>) =>
    patch({ envs: Object.keys(map).length ? JSON.stringify(map) : "" });

  /** 新建环境（支持 clone 来源） */
  const createEnv = () => {
    const name = newName.trim();
    if (!name || envMap[name]) return;
    let init: EnvGroup = { env: "", headers: "" };
    if (cloneFrom === "__base") init = { env: cfg.env ?? "", headers: cfg.headers ?? "" };
    else if (cloneFrom.startsWith("__own:")) init = envMap[cloneFrom.slice(6)] ?? init;
    else {
      const f = foreignEnvs.find((x) => x.label === cloneFrom);
      if (f) init = { env: f.env, headers: f.headers };
    }
    writeMap({ ...envMap, [name]: init });
    setSelected(name);
    setCreating(false);
    setNewName("");
    setCloneFrom("__none");
  };

  /** 删除环境（若是激活环境同时取消激活） */
  const deleteEnv = (name: string) => {
    const map = { ...envMap };
    delete map[name];
    writeMap(map);
    if (cfg.active_env === name) patch({ active_env: "" });
    if (selected === name) setSelected("__base");
  };

  /** 当前选中环境的 KV（base 或 envMap 项） */
  const cur =
    selected === "__base"
      ? { env: cfg.env ?? "", headers: cfg.headers ?? "" }
      : (envMap[selected] ?? { env: "", headers: "" });
  const updateCur = (env: string, headers: string) => {
    if (selected === "__base") patch({ env, headers });
    else writeMap({ ...envMap, [selected]: { env, headers } });
  };

  return (
    <div className="rounded-md border border-line p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12.5px] font-medium">环境组</span>
        {!creating && (
          <button
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-inksoft hover:bg-panel2 hover:text-ink"
            onClick={() => {
              setCreating(true);
              setNewName("");
              setCloneFrom("__none");
            }}
          >
            <Plus size={12} /> 新建环境
          </button>
        )}
      </div>

      {/* 环境 chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <EnvChip
          label="Base"
          active={selected === "__base"}
          onClick={() => setSelected("__base")}
        />
        {names.map((n) => (
          <span key={n} className="relative">
            <EnvChip
              label={n}
              active={selected === n}
              onClick={() => setSelected(n)}
              onDelete={() => deleteEnv(n)}
            />
            {cfg.active_env === n && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-ok" title="当前激活" />
            )}
          </span>
        ))}
        {creating && (
          <span className="flex items-center gap-1">
            <input
              className="field !py-0.5"
              style={{ width: 90 }}
              autoFocus
              placeholder="环境名"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createEnv()}
            />
            <select
              className="field !w-auto !py-0.5 text-[11.5px]"
              value={cloneFrom}
              onChange={(e) => setCloneFrom(e.target.value)}
              title="从哪里复制"
            >
              <option value="__none">空白</option>
              <option value="__base">复制 Base</option>
              {names.map((n) => (
                <option key={n} value={`__own:${n}`}>
                  复制 {n}
                </option>
              ))}
              {foreignEnvs.map((f) => (
                <option key={f.label} value={f.label}>
                  复制 {f.label}
                </option>
              ))}
            </select>
            <button className="btn-ghost h-6 !px-1.5 text-[11px]" onClick={createEnv}>
              确认
            </button>
            <button className="btn-ghost h-6 !px-1.5 text-[11px]" onClick={() => setCreating(false)}>
              取消
            </button>
          </span>
        )}
      </div>

      <p className="mb-2 mt-1.5 text-[11px] leading-relaxed text-inksoft/80">
        {selected === "__base"
          ? "Base 是该 Server 的基础配置；连接时若激活了某个环境，其同名项会覆盖 Base。"
          : `编辑环境「${selected}」：激活后连接时会覆盖 Base 的同名项。`}
      </p>

      <div className="space-y-3">
        <KVEditor
          title="环境变量"
          json={cur.env}
          onChange={(v) => updateCur(v, cur.headers)}
          keyPlaceholder="变量名"
          valuePlaceholder="值"
        />
        <KVEditor
          title="请求头"
          json={cur.headers}
          onChange={(v) => updateCur(cur.env, v)}
          keyPlaceholder="头名称"
          valuePlaceholder="值"
        />
      </div>
    </div>
  );
}

/** 环境 chip（含删除角标） */
function EnvChip({
  label,
  active,
  onClick,
  onDelete,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors ${
        active
          ? "border-primary bg-primarysoft text-primarystrong"
          : "border-line text-ink hover:bg-panel2"
      }`}
    >
      <button onClick={onClick}>{label}</button>
      {onDelete && (
        <button className="text-inksoft/50 hover:text-err" onClick={onDelete} title="删除环境">
          <X size={10} />
        </button>
      )}
    </span>
  );
}
