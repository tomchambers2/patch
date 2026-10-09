// The opening size a renderer can ask a new window for (spec/14 § New
// windows). Sizes arrive over IPC as plain JSON, so they are checked here the
// same way the route path is — Electron throws on a non-finite dimension, and
// a caller that asks for nothing must get the shell's ordinary window rather
// than a zero-sized one.

export type ChildWindowSize = { width: number; height: number };

/** The requested size, or undefined if none was asked for or it is unusable. */
export function parseWindowSize(size: unknown): ChildWindowSize | undefined {
  if (typeof size !== 'object' || size === null) return undefined;
  const { width, height } = size as { width?: unknown; height?: unknown };
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { width: Math.round(width), height: Math.round(height) };
}
