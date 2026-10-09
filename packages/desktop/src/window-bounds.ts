// Where the main window reopens (spec/05 § Window placement). Pure: main.ts
// feeds in the saved JSON and the attached displays and gets back what to hand
// BrowserWindow. The one fallback is a saved display that no longer exists.

export type Rect = { x: number; y: number; width: number; height: number };
export type DisplayInfo = { id: number; workArea: Rect };
export type SavedPlacement = Rect & { displayId: number; maximized: boolean };
export type Placement = Rect & { maximized: boolean };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The saved placement, or undefined for a missing/unreadable file (first run). */
export function parseSavedPlacement(raw: string | undefined): SavedPlacement | undefined {
  if (raw === undefined) return undefined;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof p !== 'object' || p === null) return undefined;
  const { x, y, width, height, displayId, maximized } = p;
  if (!isNum(x) || !isNum(y) || !isNum(width) || !isNum(height) || !isNum(displayId))
    return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height, displayId, maximized: maximized === true };
}

export function resolvePlacement(
  saved: SavedPlacement | undefined,
  displays: readonly DisplayInfo[],
  fallbackSize: { width: number; height: number },
): Placement {
  const target = saved && displays.find((d) => d.id === saved.displayId);
  if (saved && target) {
    const wa = target.workArea;
    const width = Math.min(saved.width, wa.width);
    const height = Math.min(saved.height, wa.height);
    const x = Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - width);
    const y = Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - height);
    return { x, y, width, height, maximized: saved.maximized };
  }
  const wa = displays[0]?.workArea;
  if (!wa) throw new Error('no displays attached');
  const width = Math.min(fallbackSize.width, wa.width);
  const height = Math.min(fallbackSize.height, wa.height);
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    width,
    height,
    maximized: false,
  };
}
