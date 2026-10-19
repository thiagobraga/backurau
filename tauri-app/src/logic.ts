// Pure comparison helpers shared by the Compare view and its dialogs.
import { baseName, parentPath } from './format';
import type { Action, ConflictChoice, FileMeta, Row } from './types';

/** Same mapping as the engine's `resolve`. */
export function resolveAction(choice: ConflictChoice, l: FileMeta | null, r: FileMeta | null): Action {
  if (choice === 'left') return l ? 'copy_right' : 'delete_right';
  if (choice === 'right') return r ? 'copy_left' : 'delete_left';
  if (choice === 'both') return l && r ? 'both' : l ? 'copy_right' : 'copy_left';
  return 'skip';
}

export const actionable = (a: Action) => a !== 'equal' && a !== 'skip';

export function effectiveAction(row: Row, resolutions: Record<string, ConflictChoice>): Action {
  const choice = resolutions[row.id];
  return choice && row.status === 'conflict' ? resolveAction(choice, row.left, row.right) : row.action;
}

export function isDestructive(action: Action, row: Row): boolean {
  if (action === 'delete_left' || action === 'delete_right' || action === 'both') return true;
  if (action === 'copy_right') return Boolean(row.right && !row.right.is_dir);
  if (action === 'copy_left') return Boolean(row.left && !row.left.is_dir);
  return false;
}

export interface TreeNode {
  row: Row;
  name: string;
  depth: number;
  children: TreeNode[];
  isDir: boolean;
}

/** Builds the folder tree of one pair; folders first, then by name. */
export function buildTree(rows: Row[], descending: boolean): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const sorted = [...rows].sort((a, b) => a.path.localeCompare(b.path));
  for (const row of sorted) {
    const node: TreeNode = { row, name: baseName(row.path), depth: 0, children: [], isDir: Boolean((row.left ?? row.right)?.is_dir) };
    byPath.set(row.path, node);
    const parent = byPath.get(parentPath(row.path));
    if (parent) {
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const order = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }) * (descending ? -1 : 1));
    nodes.forEach((n) => order(n.children));
  };
  order(roots);
  return roots;
}

export function hasChanges(node: TreeNode): boolean {
  return actionable(node.row.action) || node.row.status === 'conflict' || node.children.some(hasChanges);
}

export function descendants(node: TreeNode): Row[] {
  return node.children.flatMap((c) => [c.row, ...descendants(c)]);
}
