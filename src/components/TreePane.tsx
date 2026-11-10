/**
 * 第一栏：目录 + MCP Server 树形列表。
 *
 * 支持：目录无限嵌套、右键菜单（新建/重命名/删除/编辑配置）、拖拽移动、连接状态点。
 */
import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plug,
  Server,
  Settings2,
  Trash2,
} from "lucide-react";
import { useAppStore } from "../store";
import { buildTree, type TreeEntry } from "../lib/tree";
import type { TreeNode } from "../types";
import { ConfirmDialog, EmptyState, Modal, StatusDot } from "./ui";
import { ServerFormModal } from "./ServerFormModal";

/** 右键菜单状态 */
interface CtxMenu {
  x: number;
  y: number;
  node: TreeNode | null;
}

/** 树形栏 */
export function TreePane() {
  const { nodes, activeProjectId } = useAppStore();
  const tree = useMemo(() => buildTree(nodes), [nodes]);

  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formParent, setFormParent] = useState<number | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderParent, setFolderParent] = useState<number | null>(null);
  const [folderName, setFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<TreeNode | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);

  /** 打开「新建目录」弹窗 */
  const newFolderUnder = (parentId: number | null) => {
    setFolderParent(parentId);
    setFolderName("");
    setFolderOpen(true);
  };

  /** 提交新建目录 */
  const submitFolder = async () => {
    if (!folderName.trim()) return;
    await useAppStore.getState().createNode(folderParent, "folder", folderName.trim());
    setFolderOpen(false);
  };

  /** 右键菜单项统一入口：关闭菜单后执行动作 */
  const runMenu = (fn: () => void) => () => {
    setCtx(null);
    fn();
  };

  /** 打开右键菜单并阻止默认行为 */
  const openCtx = (e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
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

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      onContextMenu={(e) => {
        // 空白区域右键：根层新建
        if (e.target === e.currentTarget) openCtx(e, null);
      }}
    >
      {/* 栏头 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-[12px] font-semibold text-inksoft">
          {activeName ? `${activeName} · 资源树` : "资源树"}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink"
            title="新建根目录"
            onClick={() => newFolderUnder(null)}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink"
            title="新建 Server"
            onClick={() => newUnder(null)}
          >
            <Server size={14} />
          </button>
        </div>
      </div>

      {/* 树主体 */}
      <div
        className="flex-1 overflow-y-auto p-1.5"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest("[data-tree-item]")) return;
          openCtx(e, null);
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
            <TreeItem key={entry.node.id} entry={entry} depth={0} onCtx={openCtx} />
          ))
        )}
      </div>

      {/* 右键菜单 */}
      {ctx && (
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
                <CtxItem icon={<Plug size={13} />} label="连接" onClick={runMenu(() => void useAppStore.getState().connect(ctx.node!.id))} />
                <CtxItem icon={<Settings2 size={13} />} label="编辑配置" onClick={runMenu(() => {
                  void useAppStore.getState().selectNode(ctx.node!.id, { autoConnect: false });
                  setFormParent(null);
                  setFormOpen(true);
                })} />
                <div className="my-1 border-t border-line" />
              </>
            )}
            {ctx.node && (
              <>
                <CtxItem icon={<Pencil size={13} />} label="重命名" onClick={runMenu(() => {
                  // 闭包内 TS 无法保留 ctx.node 的非空收窄，此处断言安全（位于 ctx.node && 分支内）
                  const target = ctx.node!;
                  setRenameTarget(target);
                  setRenameName(target.name);
                })} />
                <div className="my-1 border-t border-line" />
                <CtxItem icon={<Trash2 size={13} />} label="删除" danger onClick={runMenu(() => setDeleteTarget(ctx.node))} />
              </>
            )}
            {!ctx.node && (
              <>
                <CtxItem icon={<FolderPlus size={13} />} label="新建目录" onClick={runMenu(() => newFolderUnder(null))} />
                <CtxItem icon={<Server size={13} />} label="新建 Server" onClick={runMenu(() => newUnder(null))} />
              </>
            )}
          </div>
        </>
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
            <button className="btn-primary" onClick={() => void submitFolder()}>
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
            <button
              className="btn-primary"
              onClick={() => {
                if (renameTarget) {
                  void useAppStore.getState().renameNode(renameTarget.id, renameName.trim());
                }
                setRenameTarget(null);
              }}
            >
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
          onKeyDown={(e) => {
            if (e.key === "Enter" && renameTarget) {
              void useAppStore.getState().renameNode(renameTarget.id, renameName.trim());
              setRenameTarget(null);
            }
          }}
        />
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
    </div>
  );
}

/** 右键菜单项 */
function CtxItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-panel2 ${
        danger ? "text-err" : "text-ink"
      }`}
      onClick={onClick}
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
}

/** 递归树条目：目录可折叠，Server 点击选中并自动连接 */
function TreeItem({ entry, depth, onCtx }: TreeItemProps) {
  const { node, children } = entry;
  const {
    expandedIds,
    toggleExpand,
    selectNode,
    selectedNodeId,
    connStates,
    connErrors,
    moveNode,
  } = useAppStore();

  const isFolder = node.node_type === "folder";
  const expanded = !!expandedIds[node.id];
  const status = isFolder ? null : (connStates[node.id] ?? "disconnected");
  const err = connErrors[node.id] || "";
  const selected = selectedNodeId === node.id;
  const [dragOver, setDragOver] = useState(false);

  return (
    <div>
      <div
        data-tree-item
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/mcpilot-node", String(node.id));
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const src = Number(e.dataTransfer.getData("text/mcpilot-node"));
          if (src && src !== node.id) {
            await moveNode(src, node.id);
          }
        }}
        className={`group flex h-8 cursor-pointer select-none items-center gap-1 rounded-md px-1.5 transition-colors ${
          selected
            ? "bg-primarysoft text-primarystrong"
            : dragOver
              ? "bg-primarysoft ring-1 ring-primary"
              : "hover:bg-panel2"
        }`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => (isFolder ? toggleExpand(node.id) : void selectNode(node.id))}
        onContextMenu={(e) => onCtx(e, node)}
        title={err ? `${node.name}\n${err}` : node.name}
      >
        {isFolder ? (
          <>
            {expanded ? (
              <ChevronDown size={14} className="shrink-0 text-inksoft" />
            ) : (
              <ChevronRight size={14} className="shrink-0 text-inksoft" />
            )}
            {expanded ? (
              <FolderOpen size={14} className="shrink-0 text-warn" />
            ) : (
              <Folder size={14} className="shrink-0 text-warn" />
            )}
          </>
        ) : (
          <>
            <span className="w-[14px] shrink-0" />
            <Server size={14} className="shrink-0 text-primarystrong" />
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px]">{node.name}</span>
        {status && <StatusDot status={status} />}
      </div>

      {isFolder && expanded && (
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
              <TreeItem key={c.node.id} entry={c} depth={depth + 1} onCtx={onCtx} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
