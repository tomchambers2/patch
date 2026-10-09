// Editor overhaul — pure-function coverage for the hierarchical file tree and
// binary-preview detection (spec/14 § File browser update):
//
//   - `buildFileTree` turns the flat list `api.listFilesRecursive` returns
//     into the nested tree `BrowsePanel` renders (component coverage for the
//     rendered tree itself lives in EditorRailExtra.test.tsx).
//   - `filterFileTree` narrows that tree by the filter box's query, keeping a
//     match's ancestor directories reachable.
//   - `isPreviewableBinary` decides which files get an image/PDF preview
//     instead of Monaco.

import { describe, it, expect } from 'vitest';
import { buildFileTree, filterFileTree, isPreviewableBinary } from '../components/EditorRail.js';
import type { TreeNode } from '../components/EditorRail.js';

describe('buildFileTree', () => {
  it('nests entries under their parent directory by path', () => {
    const tree = buildFileTree([
      { name: 'src', type: 'dir' },
      { name: 'src/a.ts', type: 'file' },
      { name: 'src/components', type: 'dir' },
      { name: 'src/components/Panel.tsx', type: 'file' },
      { name: 'zeta.ts', type: 'file' },
    ]);
    expect(tree.map((n) => n.path)).toEqual(['src', 'zeta.ts']);
    const src = tree.find((n) => n.path === 'src')!;
    expect(src.children?.map((n) => n.path)).toEqual(['src/components', 'src/a.ts']);
    const components = src.children!.find((n) => n.path === 'src/components')!;
    expect(components.children?.map((n) => n.path)).toEqual(['src/components/Panel.tsx']);
  });

  it('applies sortEntries ordering (dirs first, A→Z case-insensitive) at EVERY level, not just the top', () => {
    const tree = buildFileTree([
      { name: 'src', type: 'dir' },
      { name: 'src/zeta.ts', type: 'file' },
      { name: 'src/Apple', type: 'dir' },
      { name: 'src/banana.ts', type: 'file' },
    ]);
    const src = tree[0]!;
    expect(src.children?.map((n) => n.name)).toEqual(['Apple', 'banana.ts', 'zeta.ts']);
  });

  it('synthesizes a missing intermediate directory from a deeper file path, regardless of list order', () => {
    // Only the file is listed — no explicit entry for `src` itself (an older
    // host, or a hand-built fixture). The row still needs somewhere to live.
    const tree = buildFileTree([{ name: 'src/deep/file.ts', type: 'file' }]);
    expect(tree.map((n) => n.path)).toEqual(['src']);
    expect(tree[0]?.type).toBe('dir');
    const deep = tree[0]!.children![0]!;
    expect(deep.path).toBe('src/deep');
    expect(deep.type).toBe('dir');
    expect(deep.children![0]!.path).toBe('src/deep/file.ts');
  });

  it('fills in the real record when it arrives AFTER a placeholder was synthesized for it', () => {
    // The file comes first (synthesizing `src` as a placeholder dir), THEN
    // the real `src` entry arrives — order must not produce a duplicate row.
    const tree = buildFileTree([
      { name: 'src/a.ts', type: 'file' },
      { name: 'src', type: 'dir', dirty: false },
    ]);
    expect(tree.map((n) => n.path)).toEqual(['src']);
    expect(tree).toHaveLength(1);
  });

  it('carries the dirty flag onto file nodes, and never onto directories', () => {
    const tree = buildFileTree([
      { name: 'a.ts', type: 'file', dirty: true },
      { name: 'b.ts', type: 'file' },
    ]);
    expect(tree.find((n) => n.path === 'a.ts')?.dirty).toBe(true);
    expect(tree.find((n) => n.path === 'b.ts')?.dirty).toBeUndefined();
  });

  it('every directory node carries a `children` array (possibly empty); file nodes never do', () => {
    const tree = buildFileTree([
      { name: 'empty-dir', type: 'dir' },
      { name: 'a.ts', type: 'file' },
    ]);
    expect(tree.find((n) => n.path === 'empty-dir')?.children).toEqual([]);
    expect(tree.find((n) => n.path === 'a.ts')?.children).toBeUndefined();
  });

  it('returns an empty tree for an empty entries list', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('filterFileTree', () => {
  const tree: TreeNode[] = buildFileTree([
    { name: 'src', type: 'dir' },
    { name: 'src/components', type: 'dir' },
    { name: 'src/components/Panel.tsx', type: 'file' },
    { name: 'src/index.ts', type: 'file' },
    { name: 'README.md', type: 'file' },
  ]);

  it('an empty query returns the tree unchanged', () => {
    expect(filterFileTree(tree, '')).toBe(tree);
    expect(filterFileTree(tree, '   ')).toBe(tree);
  });

  it('keeps a matching file and every ancestor directory needed to reach it, case-insensitively', () => {
    const filtered = filterFileTree(tree, 'panel');
    expect(filtered.map((n) => n.path)).toEqual(['src']);
    const src = filtered[0]!;
    expect(src.children?.map((n) => n.path)).toEqual(['src/components']);
    const components = src.children![0]!;
    expect(components.children?.map((n) => n.path)).toEqual(['src/components/Panel.tsx']);
  });

  it('drops a sibling that does not match and has no matching descendant', () => {
    const filtered = filterFileTree(tree, 'index');
    // `src/components` (and its child) has no match anywhere under it — gone.
    const src = filtered.find((n) => n.path === 'src')!;
    expect(src.children?.map((n) => n.path)).toEqual(['src/index.ts']);
    // README.md at the top level doesn't match "index" either.
    expect(filtered.map((n) => n.path)).toEqual(['src']);
  });

  it('a directory whose OWN name matches keeps ALL of its children, not just matching ones', () => {
    const filtered = filterFileTree(tree, 'components');
    const src = filtered.find((n) => n.path === 'src')!;
    const components = src.children!.find((n) => n.path === 'src/components')!;
    expect(components.children?.map((n) => n.path)).toEqual(['src/components/Panel.tsx']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterFileTree(tree, 'nope-nothing-here')).toEqual([]);
  });

  it('does not mutate the tree it is given', () => {
    const before = JSON.parse(JSON.stringify(tree)) as unknown;
    filterFileTree(tree, 'panel');
    expect(tree).toEqual(before);
  });
});

describe('isPreviewableBinary', () => {
  it('recognises every listed image extension, case-insensitively', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']) {
      expect(isPreviewableBinary(`pic.${ext}`)).toBe('image');
      expect(isPreviewableBinary(`PIC.${ext.toUpperCase()}`)).toBe('image');
    }
  });

  it('recognises a PDF', () => {
    expect(isPreviewableBinary('report.pdf')).toBe('pdf');
    expect(isPreviewableBinary('REPORT.PDF')).toBe('pdf');
  });

  it('returns null for anything else, including a near-miss extension', () => {
    expect(isPreviewableBinary('index.ts')).toBeNull();
    expect(isPreviewableBinary('README.md')).toBeNull();
    expect(isPreviewableBinary('no-extension')).toBeNull();
    // Contains "png" but does not END with it — not a real match.
    expect(isPreviewableBinary('pngfile.txt')).toBeNull();
  });
});
