/**
 * 树结构工具：把扁平节点列表组装成树。
 */
import type { TreeNode } from "../types";

/** 树形条目：节点 + 子节点（按 sort_order、id 排序） */
export interface TreeEntry {
  node: TreeNode;
  children: TreeEntry[];
}

/**
 * 组装树。输入不要求有序；孤儿节点（父节点不在列表里）挂到根层兜底。
 *
 * @example
 * const tree = buildTree(nodes); // nodes 来自 list_nodes 的扁平结果
 */
export function buildTree(nodes: TreeNode[]): TreeEntry[] {
  const byId = new Map<number, TreeEntry>();
  for (const n of nodes) byId.set(n.id, { node: n, children: [] });

  const roots: TreeEntry[] = [];
  for (const entry of byId.values()) {
    const pid = entry.node.parent_id;
    const parent = pid != null ? byId.get(pid) : undefined;
    if (parent && parent.node.project_id === entry.node.project_id) {
      parent.children.push(entry);
    } else {
      roots.push(entry);
    }
  }

  const sortRec = (list: TreeEntry[]) => {
    list.sort((a, b) => a.node.sort_order - b.node.sort_order || a.node.id - b.node.id);
    for (const e of list) sortRec(e.children);
  };
  sortRec(roots);
  return roots;
}

/** 收集某节点及其全部后代 ID（删除/级联判断用） */
export function collectIds(entries: TreeEntry[]): number[] {
  const out: number[] = [];
  const walk = (list: TreeEntry[]) => {
    for (const e of list) {
      out.push(e.node.id);
      walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/**
 * 检查同一父目录下是否已存在同名同类型节点。
 *
 * 同步目录是资源树的树形镜像（分组 = 子目录、Server = 分组目录下的 `<别名>.json`），
 * 同目录同名会在磁盘上互相覆盖，因此新建 / 重命名 / 移动前需要实时检查；
 * 目录与 Server 同名不冲突（磁盘上一个目录一个文件），跨目录同名完全合法。
 *
 * @param nodes 当前项目的扁平节点列表（store.nodes）
 * @param parentId 目标父目录 ID；null 表示根层
 * @param name 待检名称（内部 trim，空名返回 false，由必填校验另行拦截）
 * @param nodeType 节点类型：只与同类型比较
 * @param excludeId 需排除的节点 ID（重命名 / 移动时排除自身）
 * @returns true = 存在同名冲突
 *
 * @example
 * // 新建 Server 前检查目标目录
 * siblingNameConflict(nodes, parentId, name, "server");
 * // 重命名时排除自身
 * siblingNameConflict(nodes, node.parent_id, name, node.node_type, node.id);
 */
export function siblingNameConflict(
  nodes: TreeNode[],
  parentId: number | null,
  name: string,
  nodeType: TreeNode["node_type"],
  excludeId?: number,
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return nodes.some(
    (n) =>
      n.id !== excludeId &&
      n.node_type === nodeType &&
      (n.parent_id ?? null) === (parentId ?? null) &&
      n.name.trim() === trimmed,
  );
}
