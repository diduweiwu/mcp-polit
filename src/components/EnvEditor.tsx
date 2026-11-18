/**
 * 环境组编辑：多套 env/headers 覆盖的定义与管理 UI + 独立编辑弹窗。
 *
 * - EnvSection：嵌入 Server 配置表单的环境组区块（即时写回父级 cfg）
 * - EnvEditModal：工具列表栏头「编辑环境」入口打开的弹窗，草稿式编辑
 *   当前 Server 全部环境的请求头 / 环境变量，点「保存」一次性落盘
 */
import { useEffect, useMemo, useState } from "react";
import { Info, Plus, X } from "lucide-react";
import * as api from "../api";
import { useAppStore } from "../store";
import type { ServerConfig, TreeNode } from "../types";
import { Modal } from "./ui";
import { KVEditor } from "./KVEditor";

/** 环境组结构（envs JSON 的单个条目） */
interface EnvGroup {
  env: string;
  headers: string;
}

/**
 * 环境组管理：为 server 定义多套 env/headers 覆盖（如 dev / prod），
 * 支持从 Base、本 server 其他环境或其他 server 的环境 clone。
 * 激活某环境后（栏头切换），连接时会覆盖同名的 Base 项。
 *
 * 写回通过 patch 回调交给父级（表单内为即时写回，弹窗内为写草稿）。
 */
export function EnvSection({
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

/** 环境编辑弹窗属性 */
interface EnvEditModalProps {
  /** 目标 Server 节点 */
  node: TreeNode;
  onClose: () => void;
}

/**
 * 环境编辑弹窗：草稿式编辑当前 Server 全部环境的 env/headers
 * （含 Base 与各环境的新建 / clone / 删除），点「保存」一次性落盘。
 */
export function EnvEditModal({ node, onClose }: EnvEditModalProps) {
  const updateConfigCache = useAppStore((s) => s.updateConfigCache);
  /** 本地草稿（加载完成后初始化；改动即写草稿，保存时统一落盘） */
  const [draft, setDraft] = useState<ServerConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /* 打开时按需加载配置（store 带缓存；未加载完成前显示骨架） */
  useEffect(() => {
    let alive = true;
    void useAppStore
      .getState()
      .loadConfig(node.id)
      .then((c) => {
        if (alive && c) setDraft(c);
      });
    return () => {
      alive = false;
    };
  }, [node.id]);

  /** 保存：整体落盘 + 更新配置缓存 */
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      await api.saveServerConfig(draft);
      updateConfigCache(draft);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title={`编辑环境 · ${node.name}`} onClose={onClose} width={560}>
      {!draft ? (
        <div className="h-24 animate-pulse rounded-md bg-panel2" />
      ) : (
        <div className="space-y-3">
          {error && (
            <div className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] leading-relaxed text-err">
              {error}
            </div>
          )}
          <EnvSection cfg={draft} patch={(p) => setDraft((c) => (c ? { ...c, ...p } : c))} />
          <div className="flex items-start gap-1.5 rounded-md bg-panel2 p-2.5 text-[11.5px] leading-relaxed text-inksoft">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              保存后对新连接生效：已建立的连接不会自动应用新环境，需重新连接。
            </span>
          </div>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn-primary" disabled={!draft || saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </Modal>
  );
}
