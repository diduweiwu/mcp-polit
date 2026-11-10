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
