/**
 * 第一栏：目录 + MCP Server 树形列表。
 *
 * 支持：目录无限嵌套、右键菜单（新建/复制/重命名/删除/编辑配置/断开）、拖拽移动、连接状态点。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  Loader2,
  PanelLeftClose,
  Palette,
  Pencil,
  Plug,
  PlugZap,
  Server,
  Settings2,
  Square,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { Dices } from "lucide-react";
import * as api from "../api";
import { useAppStore } from "../store";
import { buildTree, collectIds, siblingNameConflict, type TreeEntry } from "../lib/tree";
import { NODE_ICONS, nodeIconByKey, randomNodeIcon } from "../lib/node-icons";
import type { BranchInfo, ConnStatus, TreeNode } from "../types";
import { ConfirmDialog, Dropdown, EmptyState, MenuItem, Modal, StatusDot, Tooltip } from "./ui";
import { ServerFormModal } from "./ServerFormModal";

/**
 * 当前拖拽中的源节点信息（HTML5 DnD 出于安全限制在 dragover 阶段读不到
 * dataTransfer 内容，需在 dragstart 记录、dragend 清理）。
 *
 * descendantIds 用于拖拽目标校验：目录不能放进自己的后代里（防环）。
 */
let dragSrc: { id: number; descendantIds: Set<number> } | null = null;

/**
 * 执行移动：调用 store.moveNode 并统一处理失败，
 * 错误写入日志面板归属到源节点，不静默吞掉。
 *
 * 移动前先做同级同类重名前置检查（同步目录是树形镜像布局，同目录同名会
 * 互相覆盖）：拖放是高频误操作路径，冲突时提前取消并写 warn 日志，不发无效请求；
 * 后端同级重名校验兜底拦截。
 *
 * @example
 * dropMove(dragSrc.id, targetFolderId); // 拖到目录上
 * dropMove(dragSrc.id, null);           // 拖到空白区 = 移回根层
 */
async function dropMove(srcId: number, parentId: number | null) {
  const { nodes, moveNode, addLog } = useAppStore.getState();
  const src = nodes.find((n) => n.id === srcId);
  if (src && siblingNameConflict(nodes, parentId, src.name, src.node_type, srcId)) {
    addLog(
      "warn",
      `移动取消：目标目录下已存在同名${src.node_type === "folder" ? "目录" : "Server"}「${src.name}」`,
      srcId,
    );
    return;
  }
  try {
    await moveNode(srcId, parentId);
  } catch (e) {
    addLog("error", `移动失败：${String(e)}`, srcId);
  }
}

/**
 * 执行复制：调用 store.duplicateNode 并统一处理失败，
 * 错误写入日志面板归属到源节点，不静默吞掉。
 *
 * @example
 * duplicateWithLog(node.id); // 右键菜单「复制」
 */
async function duplicateWithLog(srcId: number) {
  try {
    await useAppStore.getState().duplicateNode(srcId);
  } catch (e) {
    useAppStore.getState().addLog("error", `复制失败：${String(e)}`, srcId);
  }
}

/**
 * 判断树条目自身或其子树内是否存在连接握手中的 server。
 *
 * 握手期间该链路上的节点需锁定增删改移：删除/重命名/移动会即时改写同步目录文件，
 * 与进行中的连接握手产生竞态（如握手完成后按旧节点回填工具、配置已被移走等）。
 *
 * @param entry 树条目（含子节点）
 * @param connStates 各 server 连接状态表（store.connStates）
 * @returns true = 该条目链路处于连接握手中，应禁止结构变更
 *
 * @example
 * if (entryHasConnecting(entry, connStates)) e.preventDefault(); // 拖拽发起前拦截
 */
function entryHasConnecting(entry: TreeEntry, connStates: Record<number, ConnStatus>): boolean {
  if (entry.node.node_type === "server" && connStates[entry.node.id] === "connecting") return true;
  return entry.children.some((c) => entryHasConnecting(c, connStates));
}

/**
 * 计算握手期间需锁定的节点 ID 集合：连接中的 server 及其全部祖先目录。
 *
 * 祖先目录一并锁定（删除祖先会级联删掉其中的连接中 server；重命名/移动
 * 会连带改写其下配置文件路径），子树内无连接中 server 的节点不受影响。
 *
 * @example
 * const locked = lockedNodeIds(nodes, connStates);
 * const menuDisabled = ctx.node != null && locked.has(ctx.node.id);
 */
function lockedNodeIds(
  nodes: TreeNode[],
  connStates: Record<number, ConnStatus>,
): Set<number> {
  const ids = new Set<number>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.node_type === "server" && connStates[n.id] === "connecting") {
      ids.add(n.id);
      let p = n.parent_id;
      while (p != null && !ids.has(p)) {
        ids.add(p);
        p = byId.get(p)?.parent_id ?? null;
      }
    }
  }
  return ids;
}

/** 右键菜单状态 */
interface CtxMenu {
  x: number;
  y: number;
  node: TreeNode | null;
}

/** 树形栏 */
export function TreePane() {
  const { nodes, activeProjectId, connStates } = useAppStore();
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  /** 未选择项目：全部增删入口禁用（按钮置灰、右键不弹菜单） */
  const noProject = activeProjectId == null;
  /** 连接握手中需锁定的节点（server 及其祖先目录）：禁增删改移与配置编辑 */
  const lockedIds = useMemo(() => lockedNodeIds(nodes, connStates), [nodes, connStates]);

  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  /** 右键定位高亮：被右键的节点在弹窗/菜单期间保持选中样式（null = 无，左键点击其他条目时清除） */
  const [ctxHighlight, setCtxHighlight] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formParent, setFormParent] = useState<number | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderParent, setFolderParent] = useState<number | null>(null);
  const [folderName, setFolderName] = useState("");
  /** 新建目录的失败反馈（后端同级重名校验兜底拦截时显示） */
  const [folderError, setFolderError] = useState("");
  const [renameTarget, setRenameTarget] = useState<TreeNode | null>(null);
  const [renameName, setRenameName] = useState("");
  /** 更换图标弹窗的目标节点（目录 / Server 通用） */
  const [iconTarget, setIconTarget] = useState<TreeNode | null>(null);
  /** 重命名的失败反馈（后端同级重名校验兜底拦截时显示） */
  const [renameError, setRenameError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);
  /** 收起动画播放中（淡出结束后才真正折叠） */
  const [closing, setClosing] = useState(false);
  /** 拖拽悬停在树空白区（此时放置目标 = 根层） */
  const [rootDragOver, setRootDragOver] = useState(false);

  /** 收起资源树：先播 160ms 淡出，再触发折叠 */
  const collapseWithAnim = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => {
      useAppStore.getState().toggleTreeCollapsed();
    }, 160);
  };

  /** 打开「新建目录」弹窗 */
  const newFolderUnder = (parentId: number | null) => {
    setFolderParent(parentId);
    setFolderName("");
    setFolderError("");
    setFolderOpen(true);
  };

  /** 新建目录实时重名检查：目标目录下同名目录（同步目录树形镜像布局会磁盘冲突） */
  const folderConflict = siblingNameConflict(nodes, folderParent, folderName, "folder");

  /**
   * 提交新建目录：前端重名拦截 + 后端同级校验兜底，失败反馈在弹窗内（不关闭，可改名重试）。
   */
  const submitFolder = async () => {
    const name = folderName.trim();
    if (!name || folderConflict) return;
    try {
      await useAppStore.getState().createNode(folderParent, "folder", name);
      setFolderOpen(false);
    } catch (e) {
      setFolderError(String(e));
    }
  };

  /** 右键菜单项统一入口：关闭菜单后执行动作 */
  const runMenu = (fn: () => void) => () => {
    setCtx(null);
    fn();
  };

  /** 打开右键菜单并阻止默认行为；同时把目标节点高亮定位（弹窗期间保持，便于看清正在操作谁） */
  const openCtx = (e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxHighlight(node?.id ?? null);
    setCtx({ x: e.clientX, y: e.clientY, node });
  };

  /** 在某目录下新建 */
  const newUnder = (parentId: number | null) => {
    setFormParent(parentId);
    setFormOpen(true);
  };

  const activeName = useAppStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.name,
  );
  /** 重命名实时检查：所在目录下同名同类型冲突（排除自身；目录与 Server 同名不冲突） */
  const renameConflict = renameTarget
    ? siblingNameConflict(nodes, renameTarget.parent_id, renameName, renameTarget.node_type, renameTarget.id)
    : false;

  /**
   * 提交重命名：前端重名拦截 + 后端同级校验兜底，失败反馈在弹窗内（不关闭，可改名重试）。
   */
  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name || renameConflict) return;
    try {
      await useAppStore.getState().renameNode(renameTarget.id, name);
      setRenameTarget(null);
    } catch (e) {
      setRenameError(String(e));
    }
  };
  /** 当前项目绑定的同步目录（「打开项目目录」按钮用；未绑定时按钮禁用） */
  const activeSyncDir = useAppStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.sync_dir ?? null,
  );

  /** 用系统文件管理器打开项目同步目录 */
  const openProjectDir = () => {
    if (!activeSyncDir) return;
    api
      .openDir(activeSyncDir)
      .catch((e) => useAppStore.getState().addLog("error", `打开目录失败：${e}`));
  };

  return (
    <div
      className={`flex h-full flex-col overflow-hidden ${
        closing ? "anim-fade-out" : "anim-pane-in"
      }`}
      onContextMenu={(e) => {
        // 空白区域右键：根层新建（未选项目时禁用）
        if (!noProject && e.target === e.currentTarget) openCtx(e, null);
      }}
    >
      {/* 栏头 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-[12px] font-semibold text-inksoft">
          {activeName ? `${activeName} · 资源树` : "资源树"}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            title={activeSyncDir ? "在文件管理器中打开项目目录" : "当前项目未绑定同步目录"}
            disabled={noProject || !activeSyncDir}
            onClick={openProjectDir}
          >
            <FolderOpen size={14} />
          </button>
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            title="展开全部目录"
            disabled={noProject}
            onClick={() => useAppStore.getState().expandAllFolders()}
          >
            <ChevronsUpDown size={14} />
          </button>
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            title="收起全部目录"
            disabled={noProject}
            onClick={() => useAppStore.getState().collapseAllFolders()}
          >
            <ChevronsDownUp size={14} />
          </button>
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink"
            title="收起资源树"
            onClick={collapseWithAnim}
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* 同步条：项目绑定了 git 目录时显示（分支切换 + 推送/拉取） */}
      <SyncBar />

      {/* 树主体 */}
      <div
        className={`flex-1 overflow-y-auto rounded-md p-1.5 transition-colors ${
          rootDragOver ? "bg-primarysoft/50 ring-1 ring-inset ring-primary/40" : ""
        }`}
        onContextMenu={(e) => {
          if (noProject) return;
          if ((e.target as HTMLElement).closest("[data-tree-item]")) return;
          openCtx(e, null);
        }}
        onDragOver={(e) => {
          // 空白区可作放置目标：移回根层（落在条目上的 drop 已 stopPropagation，不会到这里）
          if (!dragSrc) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setRootDragOver(true);
        }}
        onDragLeave={(e) => {
          // 仅当离开整个容器时清除高亮（进入子条目触发的 leave 会冒泡到这，忽略）
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setRootDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setRootDragOver(false);
          if (dragSrc) void dropMove(dragSrc.id, null);
        }}
      >
        {activeProjectId == null ? (
          <EmptyState text="还没有项目。点击左上角「新建项目」开始使用。" />
        ) : tree.length === 0 ? (
          <EmptyState
            icon={<Folder size={36} strokeWidth={1.2} />}
            text="空项目。右键此处或在上方按钮新建目录 / Server。"
          />
        ) : (
          tree.map((entry) => (
            <TreeItem
              key={entry.node.id}
              entry={entry}
              depth={0}
              onCtx={openCtx}
              highlightId={ctxHighlight}
              onUserClick={() => setCtxHighlight(null)}
            />
          ))
        )}
      </div>

      {/* 右键菜单（Portal 到 body，避免被分栏绘制层覆盖） */}
      {ctx && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />
          <div
            className="card anim-pop-in fixed z-50 min-w-[150px] overflow-hidden py-1 shadow-xl"
            style={{ left: ctx.x, top: ctx.y }}
          >
            {ctx.node?.node_type === "folder" && (
              <>
                <CtxItem icon={<FolderPlus size={13} />} label="新建子目录" onClick={runMenu(() => newFolderUnder(ctx.node!.id))} />
                <CtxItem icon={<Server size={13} />} label="新建 Server" onClick={runMenu(() => newUnder(ctx.node!.id))} />
                <div className="my-1 border-t border-line" />
              </>
            )}
            {ctx.node?.node_type === "server" && (
              <>
                {(() => {
                  // 已连接 → 快捷断开；连接中 → 中断（取消握手，不必等超时）；
                  // 未连接/失败才可发起连接
                  const st = connStates[ctx.node!.id];
                  return st === "connecting" ? (
                    <CtxItem icon={<Square size={11} className="fill-current" />} label="中断连接" onClick={runMenu(() => void useAppStore.getState().cancelConnect(ctx.node!.id))} />
                  ) : st === "connected" ? (
                    <CtxItem icon={<PlugZap size={13} />} label="断开连接" onClick={runMenu(() => void useAppStore.getState().disconnect(ctx.node!.id))} />
                  ) : (
                    <CtxItem icon={<Plug size={13} />} label="连接" onClick={runMenu(() => void useAppStore.getState().connect(ctx.node!.id))} />
                  );
                })()}
                <CtxItem
                  icon={<Settings2 size={13} />}
                  label="编辑配置"
                  disabled={connStates[ctx.node!.id] === "connecting"}
                  onClick={runMenu(() => {
                    void useAppStore.getState().selectNode(ctx.node!.id, { autoConnect: false });
                    setFormParent(null);
                    setFormOpen(true);
                  })}
                />
                <div className="my-1 border-t border-line" />
              </>
            )}
            {ctx.node && (
              <>
                <CtxItem
                  icon={<Palette size={13} />}
                  label="更换图标"
                  onClick={runMenu(() => setIconTarget(ctx.node!))}
                />
                <CtxItem
                  icon={<Copy size={13} />}
                  label="复制"
                  disabled={lockedIds.has(ctx.node.id)}
                  onClick={runMenu(() => void duplicateWithLog(ctx.node!.id))}
                />
                <CtxItem
                  icon={<Pencil size={13} />}
                  label="重命名"
                  disabled={lockedIds.has(ctx.node.id)}
                  onClick={runMenu(() => {
                    // 闭包内 TS 无法保留 ctx.node 的非空收窄，此处断言安全（位于 ctx.node && 分支内）
                    const target = ctx.node!;
                    setRenameTarget(target);
                    setRenameName(target.name);
                    setRenameError("");
                  })}
                />
                <div className="my-1 border-t border-line" />
                <CtxItem
                  icon={<Trash2 size={13} />}
                  label="删除"
                  danger
                  disabled={lockedIds.has(ctx.node.id)}
                  onClick={runMenu(() => setDeleteTarget(ctx.node))}
                />
              </>
            )}
            {!ctx.node && (
              <>
                <CtxItem icon={<FolderPlus size={13} />} label="新建目录" onClick={runMenu(() => newFolderUnder(null))} />
                <CtxItem icon={<Server size={13} />} label="新建 Server" onClick={runMenu(() => newUnder(null))} />
              </>
            )}
          </div>
        </>,
        document.body,
      )}

      {/* 新建目录弹窗 */}
      <Modal
        open={folderOpen}
        title="新建目录"
        onClose={() => setFolderOpen(false)}
        width={420}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setFolderOpen(false)}>
              取消
            </button>
            <button className="btn-primary" disabled={folderConflict} onClick={() => void submitFolder()}>
              创建
            </button>
          </>
        }
      >
        <label className="label">目录名称</label>
        <input
          className="field"
          autoFocus
          placeholder="例如：数据工具 / 内网服务"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submitFolder()}
        />
        {folderConflict && (
          <p className="mt-1.5 text-[11.5px] text-err">同目录下已存在同名目录，请换一个名称</p>
        )}
        {folderError && (
          <p className="mt-1.5 break-all text-[11.5px] text-err">{folderError}</p>
        )}
      </Modal>

      {/* 新建 Server 弹窗 */}
      {formOpen && (
        <ServerFormModal
          parentId={formParent}
          onClose={() => setFormOpen(false)}
        />
      )}

      {/* 重命名弹窗 */}
      <Modal
        open={renameTarget != null}
        title={renameTarget?.node_type === "server" ? "重命名 Server 别名" : "重命名目录"}
        onClose={() => setRenameTarget(null)}
        width={420}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setRenameTarget(null)}>
              取消
            </button>
            <button className="btn-primary" disabled={renameConflict} onClick={() => void submitRename()}>
              保存
            </button>
          </>
        }
      >
        <label className="label">名称</label>
        <input
          className="field"
          autoFocus
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submitRename()}
        />
        {renameConflict && (
          <p className="mt-1.5 text-[11.5px] text-err">同目录下已存在同名{renameTarget?.node_type === "server" ? " Server" : "目录"}，请换一个名称</p>
        )}
        {renameError && (
          <p className="mt-1.5 break-all text-[11.5px] text-err">{renameError}</p>
        )}
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget != null}
        title={deleteTarget?.node_type === "folder" ? "删除目录" : "删除 Server"}
        message={
          deleteTarget?.node_type === "folder"
            ? `确定删除目录「${deleteTarget?.name}」吗？其下全部子目录与 Server 配置将一并删除。`
            : `确定删除 Server「${deleteTarget?.name}」吗？其连接配置将一并删除。`
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void useAppStore.getState().deleteNode(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />

      {/* 更换图标弹窗：目录 / Server 通用 */}
      {iconTarget && (
        <IconPickerModal nodeId={iconTarget.id} onClose={() => setIconTarget(null)} />
      )}
    </div>
  );
}

/**
 * 更换图标弹窗：网格展示全部注册图标，点击立即应用（可连续试选，实时落盘并触发同步导出）；
 * 「随机一个」一键换随机图标，「恢复默认」清空自定义回退类型默认图标。
 * 节点当前图标从 store 实时解析（应用后 reloadNodes，选中高亮跟随更新）。
 */
function IconPickerModal({ nodeId, onClose }: { nodeId: number; onClose: () => void }) {
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  const [error, setError] = useState("");
  /** 当前生效的自定义图标 key（null = 默认图标；应用后随 store 刷新） */
  const current = node?.icon ?? null;

  /** 应用一个图标 key（或 null 恢复默认）；失败行内提示，不关弹窗可重试 */
  const apply = async (key: string | null) => {
    try {
      setError("");
      await useAppStore.getState().setNodeIcon(nodeId, key);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal open title="更换图标" onClose={onClose} width={460}>
      {/* 当前节点预览 */}
      <div className="mb-3 flex items-center gap-2 rounded-md bg-panel2 px-2.5 py-2">
        <span className="text-[12px] text-inksoft">当前节点</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium text-ink">
          {node?.name ?? ""}
        </span>
        {(() => {
          const def = nodeIconByKey(current);
          return def ? (
            <span className="flex items-center gap-1 text-[11px] text-inksoft/70">
              <def.Icon size={14} /> {def.label}
            </span>
          ) : (
            <span className="text-[11px] text-inksoft/50">默认图标</span>
          );
        })()}
      </div>

      {/* 图标网格：点击即应用 */}
      <div className="grid grid-cols-8 gap-1">
        {NODE_ICONS.map((d) => {
          const active = current === d.key;
          return (
            <button
              key={d.key}
              title={d.label}
              onClick={() => void apply(d.key)}
              className={`flex h-9 items-center justify-center rounded-md border transition-colors ${
                active
                  ? "border-primary bg-primarysoft text-primarystrong"
                  : "border-line text-inksoft hover:border-primary/50 hover:bg-panel2 hover:text-ink"
              }`}
            >
              <d.Icon size={16} />
            </button>
          );
        })}
      </div>

      {/* 操作行：一键随机 / 恢复默认 */}
      <div className="mt-3 flex items-center gap-1.5">
        <button
          className="btn-ghost h-8 flex-1 gap-1.5 text-[12px]"
          title="随机选一个图标"
          onClick={() => void apply(randomNodeIcon().key)}
        >
          <Dices size={14} /> 随机一个
        </button>
        <button
          className="btn-ghost h-8 flex-1 text-[12px]"
          title="清除自定义图标，回退类型默认图标"
          disabled={current == null}
          onClick={() => void apply(null)}
        >
          恢复默认
        </button>
        <button className="btn-primary h-8 flex-1 text-[12px]" onClick={onClose}>
          完成
        </button>
      </div>
      {error && <p className="mt-1.5 break-all text-[11.5px] text-err">{error}</p>}
    </Modal>
  );
}

/**
 * 同步条：项目绑定了 git 目录时显示。
 * 分支下拉（点击切换，checkout 后刷新树）+ 推送（弹窗填写提交信息后 commit+push）/
 * 拉取（pull+导入）；每 10s 定时检查仓库状态（外部删 .git / 手动 git init 恢复及时反映）；
 * 目录读不到分支时推送/拉取先弹确认（自动 git init 是显式动作，不再静默成功）；
 * 同步结果与错误压缩为栏头一枚状态图标（按级别变色，悬浮显示全文、点击弹详情弹窗，
 * 常驻到下次同步结果替换），不占正文空间。
 */
function SyncBar() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const { addLogs, reloadNodes } = useAppStore();
  const [info, setInfo] = useState<BranchInfo | null>(null);
  const [busy, setBusy] = useState<"push" | "pull" | null>(null);
  /** 结果/错误提醒横幅（info 自动消失，warn/error 常驻：不提供手动清除，
      直到下次同步产出新结果被替换——成功即绿色 info 自动消失=问题已解决） */
  const [notice, setNotice] = useState<SyncNotice | null>(null);
  /** 同步结果详情弹窗（点击状态图标打开；Portal 到 body 不受分栏裁剪） */
  const [noticeOpen, setNoticeOpen] = useState(false);
  /** 推送确认弹窗：填写提交信息（可留空用默认） */
  const [pushOpen, setPushOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  /** 推送/拉取前确认：目录读不到分支（非 git 仓库或 git 不可用）时先征求同意再自动初始化，不再静默成功 */
  const [initConfirm, setInitConfirm] = useState<"push" | "pull" | null>(null);
  /** 分支/仓库状态是否处于异常（定时检查用它防同一异常反复刷提醒） */
  const branchBrokenRef = useRef(false);

  const hasSync = !!project?.sync_dir;

  /**
   * 读取分支信息（挂载/切项目/定时检查/同步完成 后共用）。
   * 成功：更新分支下拉，并清除「分支读取失败」类提醒（目录可能被外部 git init 恢复）。
   * 失败：清空下拉；仅在「正常 → 异常」跃迁时提醒，定时检查不反复刷同一告警。
   */
  const refreshBranches = useCallback((pid: number) => {
    api
      .projectBranches(pid)
      .then((next) => {
        branchBrokenRef.current = false;
        setInfo(next);
        setNotice((n) => (n?.kind === "branch" ? null : n));
      })
      .catch((e) => {
        if (branchBrokenRef.current) return;
        branchBrokenRef.current = true;
        setInfo(null);
        useAppStore.getState().addLog("warn", String(e));
        setNotice({
          level: "warn",
          kind: "branch",
          text: `无法读取分支信息：${String(e)}。同步目录可能不是 git 仓库（或 git 不可用），请检查目录后手动处理`,
        });
      });
  }, []);

  /* 项目切换/挂载时读取分支信息；读取失败时图标提醒（不再只静默写日志，否则同步条看不到分支名） */
  useEffect(() => {
    branchBrokenRef.current = false;
    setInfo(null);
    setNotice(null);
    if (!hasSync || activeProjectId == null) return;
    refreshBranches(activeProjectId);
  }, [hasSync, activeProjectId, refreshBranches]);

  /* 定时检查仓库状态（10s）：外部删掉 .git / 手动 git init 恢复等变化及时反映到栏头，
     分支下拉与推送/拉取按钮的确认逻辑随之更新 */
  useEffect(() => {
    if (!hasSync || activeProjectId == null) return;
    const t = window.setInterval(() => refreshBranches(activeProjectId), 10_000);
    return () => window.clearInterval(t);
  }, [hasSync, activeProjectId, refreshBranches]);

  /* info 级提醒 6 秒后自动消失（仅清理仍然为 info 的横幅，避免误关新错误） */
  useEffect(() => {
    if (notice?.level !== "info") return;
    const t = window.setTimeout(() => {
      setNotice((n) => (n?.level === "info" ? null : n));
    }, 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  if (!hasSync || !project) return null;

  /** 从本次同步日志提炼横幅提醒：error > warn > info（取最高严重级展示） */
  const noticeOf = (
    logs: Array<{ level: string; message: string }>,
    dir: "push" | "pull",
  ): SyncNotice => {
    const label = dir === "push" ? "推送" : "拉取";
    const err = logs.find((l) => l.level === "error");
    if (err) {
      // 冲突类错误的后端日志已自带「手动处理」引导，不再重复拼接通用文案
      const text = err.message.includes("手动处理")
        ? `${label}失败：${err.message}，完整信息见日志面板`
        : `${label}失败：${err.message}。请检查同步目录 / 远端仓库（网络、权限、冲突）后手动处理，完整信息见日志面板`;
      return { level: "error", kind: "sync", text };
    }
    const warn = logs.find((l) => l.level === "warn");
    if (warn) {
      return { level: "warn", kind: "sync", text: `${label}完成但有警告：${warn.message}。建议检查处理，完整信息见日志面板` };
    }
    const ok = logs.length ? logs[logs.length - 1].message : `${label}完成`;
    return { level: "info", kind: "sync", text: `${label}完成：${ok}` };
  };

  /** 执行推送 / 拉取（push 传入弹窗填写的提交信息，可为 null 用默认） */
  const doSync = async (dir: "push" | "pull", message?: string | null) => {
    setBusy(dir);
    try {
      const logs =
        dir === "push"
          ? await api.projectSyncPush(project.id, message)
          : await api.projectSyncPull(project.id);
      addLogs(logs);
      setNotice(noticeOf(logs, dir));
      if (dir === "pull") await reloadNodes();
      /* 推送/拉取会改变仓库状态（如推送对旧版误删 .git 的目录自动 git init 重建、
         首次提交让 unborn 分支诞生），完成后刷新分支下拉，无需重启应用 */
      refreshBranches(project.id);
    } catch (e) {
      const label = dir === "push" ? "推送" : "拉取";
      useAppStore.getState().addLog("error", String(e));
      setNotice({
        level: "error",
        kind: "sync",
        text: `${label}失败：${String(e)}。请检查同步目录 / 远端仓库后手动处理，完整信息见日志面板`,
      });
    } finally {
      setBusy(null);
    }
  };

  /** 切换分支（点击当前分支不做任何操作：对尚无提交的仓库 checkout 自己会报 pathspec 错） */
  const switchBranch = async (branch: string) => {
    if (activeProjectId == null || branch === info?.current) return;
    try {
      await api.projectCheckout(project.id, branch);
      const next = await api.projectBranches(project.id);
      setInfo(next);
      setNotice({ level: "info", kind: "sync", text: `已切换分支：${branch}（分支间内容可能不同，可点击「拉取」加载该分支配置）` });
    } catch (e) {
      useAppStore.getState().addLog("error", String(e));
      setNotice({ level: "error", kind: "sync", text: `切换分支失败：${String(e)}。请检查仓库状态（可能有未提交改动）后手动处理` });
    }
  };

  /** 确认推送：关闭弹窗并携带提交信息执行（留空 → 后端用默认提交信息） */
  const confirmPush = () => {
    setPushOpen(false);
    void doSync("push", commitMsg.trim() || null);
  };

  /**
   * 推送/拉取入口（按钮共用）：目录读不到分支（非 git 仓库或 git 不可用）时
   * 先弹确认征求同意——自动 git init 是显式动作，不再静默成功；正常目录行为不变。
   */
  const startSync = (dir: "push" | "pull") => {
    if (busy != null) return;
    if (info == null) {
      setInitConfirm(dir);
      return;
    }
    if (dir === "push") {
      setCommitMsg("");
      setPushOpen(true);
    } else {
      void doSync("pull");
    }
  };

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel2/60 px-2">
        <GitBranch size={12} className="shrink-0 text-inksoft" />
        {info ? (
          <Dropdown
            trigger={(open, toggle) => (
              <button
                className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-ink transition-colors hover:bg-panel"
                onClick={toggle}
                title={`当前分支：${info.current}（点击切换）`}
              >
                <span className="max-w-[90px] truncate">{info.current}</span>
                <ChevronDown size={11} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
              </button>
            )}
          >
            {(close) => (
              <>
                {info.branches.length === 0 && (
                  <div className="px-3 py-1.5 text-[12px] text-inksoft">（仓库还没有任何分支）</div>
                )}
                {info.branches.map((b) => (
                  <MenuItem
                    key={b}
                    label={b}
                    icon={b === info.current ? <Check size={13} className="text-primarystrong" /> : <span className="w-[13px]" />}
                    onClick={() => {
                      void switchBranch(b);
                      close();
                    }}
                  />
                ))}
              </>
            )}
          </Dropdown>
        ) : (
          <span className="text-[11.5px] text-inksoft/70">Git 同步</span>
        )}
        {/* 同步结果/错误提醒：压缩成栏头一枚状态图标；悬浮显示全文气泡（自定义
            Tooltip：WKWebView 不渲染原生 title），点击弹「同步结果」弹窗看全文——
            详情不再用栏内下拉（窄栏下会被 overflow-hidden 裁剪，Portal 弹窗不受限）；
            图标不因点击消失，常驻到下次同步结果替换；
            error 红 / warn 黄 / info 绿 */}
        {notice && (
          <Tooltip content={`${notice.text}（点击查看详情）`}>
            <button
              aria-label={`同步结果提醒（点击查看详情）：${notice.text}`}
              className={`shrink-0 rounded p-0.5 transition-colors hover:bg-panel ${
                notice.level === "error"
                  ? "text-err"
                  : notice.level === "warn"
                    ? "text-warn"
                    : "text-ok"
              }`}
              onClick={() => setNoticeOpen(true)}
            >
              {notice.level === "info" ? (
                <CheckCircle2 size={13} />
              ) : notice.level === "warn" ? (
                <AlertTriangle size={13} />
              ) : (
                <AlertCircle size={13} />
              )}
            </button>
          </Tooltip>
        )}
        <span className="flex-1" />
        <button
          className="rounded p-1 text-inksoft transition-colors hover:bg-panel hover:text-ink disabled:opacity-50"
          title={info == null
            ? "推送：当前读不到分支信息，点击后需确认自动初始化仓库"
            : `推送：导出当前配置并 commit + push（分支 ${info.current}）`}
          disabled={busy != null}
          onClick={() => startSync("push")}
        >
          {busy === "push" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        </button>
        <button
          className="rounded p-1 text-inksoft transition-colors hover:bg-panel hover:text-ink disabled:opacity-50"
          title={info == null
            ? "拉取：当前读不到分支信息，点击后需确认自动初始化仓库"
            : `拉取：pull 并覆盖加载该分支的配置（分支 ${info.current}）`}
          disabled={busy != null}
          onClick={() => startSync("pull")}
        >
          {busy === "pull" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        </button>
      </div>

      {/* 推送确认弹窗：填写提交信息（可留空用默认），展示目标项目与分支 */}
      <Modal
        open={pushOpen}
        title="推送到 Git 仓库"
        onClose={() => setPushOpen(false)}
        width={440}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPushOpen(false)} disabled={busy === "push"}>
              取消
            </button>
            <button className="btn-primary" disabled={busy === "push"} onClick={confirmPush}>
              {busy === "push" ? "推送中…" : "推送"}
            </button>
          </>
        }
      >
        <p className="mb-3 text-[12px] leading-relaxed text-inksoft">
          将把项目「{project.name}」的当前配置导出并提交到分支
          <span className="mx-1 font-mono text-primarystrong">{info?.current ?? "?"}</span>
          ，然后推送到远端仓库。
        </p>
        <label className="label">提交信息（可选）</label>
        <input
          className="field"
          autoFocus
          placeholder="留空使用默认：MCPilot 配置同步"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && confirmPush()}
        />
      </Modal>

      {/* 同步结果详情弹窗：Portal 到 body，不受分栏 overflow 裁剪。
          弹窗仅用于阅读，不提供手动清除：warn/error 图标常驻，直到下次同步
          产出新结果被替换（成功→绿色 info 自动消失=问题已解决）。
          notice 为 null（info 自动消失）时弹窗随之关闭 */}
      <Modal
        open={noticeOpen && notice != null}
        title="同步结果"
        onClose={() => setNoticeOpen(false)}
        width={440}
        footer={
          <button className="btn-primary" onClick={() => setNoticeOpen(false)}>
            知道了
          </button>
        }
      >
        {notice && (
          <div className="flex items-start gap-2.5">
            <span
              className={`mt-0.5 shrink-0 ${
                notice.level === "error" ? "text-err" : notice.level === "warn" ? "text-warn" : "text-ok"
              }`}
            >
              {notice.level === "info" ? (
                <CheckCircle2 size={18} />
              ) : notice.level === "warn" ? (
                <AlertTriangle size={18} />
              ) : (
                <AlertCircle size={18} />
              )}
            </span>
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{notice.text}</p>
          </div>
        )}
      </Modal>

      {/* 非 git 仓库目录的推送/拉取确认：自动 git init 重建仓库是显式动作，
          用户知情后继续才执行（对旧版误删 .git 的目录这也是恢复入口） */}
      <ConfirmDialog
        open={initConfirm != null}
        title={initConfirm === "pull" ? "拉取前确认" : "推送前确认"}
        message={`无法读取分支信息，同步目录可能不是 git 仓库（或 git 不可用）。继续将自动执行 git init 初始化仓库，然后${initConfirm === "pull" ? "从仓库拉取导入配置" : "提交并推送全部内容"}。`}
        confirmText="继续"
        danger={false}
        onConfirm={() => {
          const dir = initConfirm;
          setInitConfirm(null);
          if (dir === "pull") {
            void doSync("pull");
          } else {
            setCommitMsg("");
            setPushOpen(true);
          }
        }}
        onCancel={() => setInitConfirm(null)}
      />
    </>
  );
}

/** 同步条提醒的数据（栏头状态图标展示：图标按级别变色，悬浮/点击弹详情查看全文） */
interface SyncNotice {
  /** 提醒级别：error 红 / warn 黄 / info 绿（info 6s 自动消失，其余常驻到下次同步结果替换） */
  level: "info" | "warn" | "error";
  /** 提醒来源：branch=分支/仓库状态读取失败（定时检查发现恢复后自动清除）；sync=推送/拉取/切分支结果 */
  kind: "branch" | "sync";
  /** 展示文本（含手动处理引导） */
  text: string;
}

/** 右键菜单项（disabled 置灰不可点：如连接握手期间锁定的结构操作） */
function CtxItem({
  icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-panel2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        danger ? "text-err" : "text-ink"
      }`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      {label}
    </button>
  );
}

/** 树条目属性 */
interface TreeItemProps {
  entry: TreeEntry;
  depth: number;
  onCtx: (e: React.MouseEvent, node: TreeNode) => void;
  /** 右键定位高亮的节点 ID（null = 无）；匹配且未选中时显示定位背景 */
  highlightId: number | null;
  /** 用户左键点击本条目时回调（清除右键定位高亮，注意力已转移） */
  onUserClick: () => void;
}

/** 递归树条目：目录可折叠，Server 点击选中并自动连接 */
function TreeItem({ entry, depth, onCtx, highlightId, onUserClick }: TreeItemProps) {
  const { node, children } = entry;
  const {
    expandedIds,
    toggleExpand,
    selectNode,
    selectedNodeId,
    connStates,
    connErrors,
    connect,
  } = useAppStore();

  const isFolder = node.node_type === "folder";
  const expanded = !!expandedIds[node.id];
  const status = isFolder ? null : (connStates[node.id] ?? "disconnected");
  const err = connErrors[node.id] || "";
  const selected = selectedNodeId === node.id;
  const [dragOver, setDragOver] = useState(false);
  /** 自定义图标（注册表查不到的旧 key 回退 undefined = 默认图标，不报错） */
  const customIcon = nodeIconByKey(node.icon);

  return (
    <div>
      <div
        data-tree-item
        draggable
        onDragStart={(e) => {
          // 自身或子树内有连接握手中的 server：禁止拖动（结构变更与进行中的握手竞态）
          if (entryHasConnecting(entry, connStates)) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData("text/mcpilot-node", String(node.id));
          e.dataTransfer.effectAllowed = "move";
          // 记录源节点与其后代集合：dragover 阶段读不到 dataTransfer，且目录不能放进自己的后代（防环）
          dragSrc = { id: node.id, descendantIds: new Set(collectIds(children)) };
        }}
        onDragEnd={() => {
          dragSrc = null;
        }}
        onDragOver={(e) => {
          // 仅目录可作放置目标；拖到自己或自己的后代上不响应（不高亮、不拦截，事件继续冒泡给外层目录）
          if (!isFolder || !dragSrc) return;
          if (dragSrc.id === node.id || dragSrc.descendantIds.has(node.id)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          if (dragSrc) void dropMove(dragSrc.id, node.id);
        }}
        className={`group flex h-8 cursor-pointer select-none items-center gap-1 rounded-md px-1.5 transition-colors ${
          selected || highlightId === node.id
            ? /* 单击选中（server）/ 右键定位（目录与 server）：同一选中样式，弹窗期间保持可见 */
              "bg-primarysoft text-primarystrong"
            : dragOver
              ? "bg-primarysoft ring-1 ring-primary"
              : /* 焦点背景与 hover 同色：点击展开/收起后鼠标移开仍保留聚焦反馈；
                   纯键盘 Tab 导航（focus-visible）再加内缘细环，与点击场景区分 */
                "hover:bg-hover focus:outline-none focus:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
        }`}
        style={{ paddingLeft: 6 + depth * 14 }}
        role="button"
        tabIndex={0}
        aria-expanded={isFolder ? expanded : undefined}
        onClick={() => {
          onUserClick();
          if (isFolder) toggleExpand(node.id);
          else void selectNode(node.id);
        }}
        onKeyDown={(e) => {
          // 键盘可达：Enter/Space 等价单击（目录展开收起 / server 选中），并阻止页面滚动
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isFolder) toggleExpand(node.id);
            else void selectNode(node.id);
          }
        }}
        onDoubleClick={() => !isFolder && void connect(node.id)}
        onContextMenu={(e) => onCtx(e, node)}
        title={
          err
            ? `${node.name}\n${err}`
            : isFolder
              ? node.name
              : `${node.name}\n单击查看配置，双击连接`
        }
      >
        {isFolder ? (
          <>
            {/* 展开时朝下，收起时旋转 -90° 带过渡 */}
            <ChevronDown
              size={14}
              className={`shrink-0 text-inksoft transition-transform duration-200 ${
                expanded ? "" : "-rotate-90"
              }`}
            />
            {/* 自定义图标优先；无自定义时保持默认（展开/收起两态） */}
            {customIcon ? (
              <customIcon.Icon size={14} className="shrink-0 text-inksoft" />
            ) : expanded ? (
              <FolderOpen size={14} className="shrink-0 text-inksoft" />
            ) : (
              <Folder size={14} className="shrink-0 text-inksoft" />
            )}
          </>
        ) : (
          <>
            <span className="w-[14px] shrink-0" />
            {/* 按传输协议着色标识：stdio=终端绿，Streamable HTTP=地球紫（自定义图标同色，视觉体系不乱） */}
            {customIcon ? (
              <customIcon.Icon
                size={14}
                className={`shrink-0 ${
                  node.transport_type === "streamable_http" ? "text-violet-500" : "text-emerald-500"
                }`}
              />
            ) : node.transport_type === "streamable_http" ? (
              <Globe size={14} className="shrink-0 text-violet-500" />
            ) : (
              <Terminal size={14} className="shrink-0 text-emerald-500" />
            )}
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px]">{node.name}</span>
        {status && <StatusDot status={status} />}
      </div>

      {/* 子节点：grid-rows 高度过渡实现展开/收起动画 */}
      {isFolder && (
        <div className={`tree-children ${expanded ? "open" : ""}`}>
          <div>
            {children.length === 0 ? (
              <div
                className="py-1 text-[12px] text-inksoft/70"
                style={{ paddingLeft: 30 + depth * 14 }}
              >
                （空目录）
              </div>
            ) : (
            children.map((c) => (
              <TreeItem
                key={c.node.id}
                entry={c}
                depth={depth + 1}
                onCtx={onCtx}
                highlightId={highlightId}
                onUserClick={onUserClick}
              />
            ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
