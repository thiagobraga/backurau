import { describe, expect, it } from 'vitest';
import { formatSize, plural } from '../src/format';
import { buildTree, effectiveAction, isDestructive, resolveAction } from '../src/logic';
import type { FileMeta, Row } from '../src/types';

const meta = (size = 1, is_dir = false): FileMeta => ({ size, modified: 0, is_dir, hash: null });
const row = (path: string, extra: Partial<Row> = {}): Row => ({
  id: path, pair_id: 'p', path, left: meta(), right: null, status: 'added', action: 'copy_right', selected: true, reason: null, ...extra,
});

describe('conflict resolution', () => {
  it('maps choices to actions like the engine', () => {
    expect(resolveAction('left', meta(), meta())).toBe('copy_right');
    expect(resolveAction('left', null, meta())).toBe('delete_right');
    expect(resolveAction('right', meta(), meta())).toBe('copy_left');
    expect(resolveAction('both', meta(), meta())).toBe('both');
    expect(resolveAction('skip', meta(), meta())).toBe('skip');
  });

  it('applies a resolution only to conflict rows', () => {
    const conflict = row('a', { status: 'conflict', action: 'conflict', right: meta() });
    expect(effectiveAction(conflict, { a: 'right' })).toBe('copy_left');
    expect(effectiveAction(row('b'), { b: 'right' })).toBe('copy_right');
  });

  it('flags overwrites and deletions as destructive', () => {
    expect(isDestructive('delete_right', row('a'))).toBe(true);
    expect(isDestructive('copy_right', row('a', { right: meta() }))).toBe(true);
    expect(isDestructive('copy_right', row('a'))).toBe(false);
  });
});

describe('buildTree', () => {
  it('nests rows under their folder, folders first', () => {
    const tree = buildTree([row('z.txt'), row('d', { left: meta(0, true) }), row('d/inner.txt')], false);
    expect(tree.map((n) => n.name)).toEqual(['d', 'z.txt']);
    expect(tree[0].children.map((n) => n.name)).toEqual(['inner.txt']);
    expect(tree[0].children[0].depth).toBe(1);
  });
});

describe('format', () => {
  it('formats sizes in decimal units', () => {
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(1500)).toBe('1.5 KB');
    expect(formatSize(2_000_000)).toBe('2 MB');
  });
  it('pluralizes', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(2, 'file')).toBe('2 files');
  });
});
