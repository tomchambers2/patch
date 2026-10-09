// Full-screen markup editor for a pending image attachment (Skitch-style: box,
// arrow, freehand, text over a screenshot before it's sent). Opened from the
// pencil affordance on an image thumbnail in the composer; on save it hands
// back a flattened PNG File that replaces the pending attachment.
//
// Portalled to <body> for the same reason as ImageLightbox (ChatRoute.tsx) —
// `.chat-main` has `contain: layout`, which would clip a `position: fixed`
// overlay to the chat panel instead of covering the window.
//
// One canvas holds both the source image and every committed mark, redrawn
// from `shapes` on every change — so "Done" is just `canvas.toBlob()` on the
// canvas that's already on screen, no separate flatten pass.

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Square, ArrowUpRight, Pencil, Type, Undo2, Check } from 'lucide-react';
import { CloseIcon } from './icons.js';

type Tool = 'box' | 'arrow' | 'pen' | 'text';

interface Point {
  x: number;
  y: number;
}
interface BoxShape {
  kind: 'box';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}
interface ArrowShape {
  kind: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}
interface PenShape {
  kind: 'pen';
  points: Point[];
  color: string;
}
interface TextShape {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
}
type Shape = BoxShape | ArrowShape | PenShape | TextShape;

/** Preset palette — a personal tool for one user; five swatches beat a full picker. */
const COLORS = ['#e0393e', '#f5a623', '#3d8bfd', '#2ecc71', '#111111'];
const DEFAULT_COLOR: string = COLORS[0] ?? '#e0393e';

export interface ImageAnnotatorProps {
  file: File;
  onDone(file: File): void;
  onCancel(): void;
}

export function ImageAnnotator({ file, onDone, onCancel }: ImageAnnotatorProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<Tool>('box');
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const drawingRef = useRef(false);
  const [textEditor, setTextEditor] = useState<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  // Decode the source file once and size the canvas to its natural resolution
  // (marks are stored/drawn in image-pixel space, not screen-pixel space, so
  // the exported PNG is full quality regardless of how small/large it's shown).
  //
  // Display size is set explicitly (not left to CSS max-width/max-height)
  // because those only ever shrink — a small screenshot would render at its
  // tiny native size in the middle of an otherwise empty full-screen backdrop.
  // Scaling to fit the available box in JS works both ways: small images grow
  // to fill it, oversized ones shrink, exactly like `object-fit: contain`
  // would if the box had an explicit size to fit into.
  useEffect(() => {
    let cancelled = false;
    createImageBitmap(file).then((bmp) => {
      if (cancelled) {
        bmp.close();
        return;
      }
      bitmapRef.current = bmp;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        applyDisplaySize(canvas);
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
      bitmapRef.current?.close();
    };
  }, [file]);

  // Keep the fit current if the window is resized mid-edit.
  useEffect(() => {
    const onResize = (): void => {
      const canvas = canvasRef.current;
      if (canvas && bitmapRef.current) applyDisplaySize(canvas);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const lineWidth = useCallback(
    () => Math.max(3, Math.round((bitmapRef.current?.width ?? 800) / 260)),
    [],
  );
  const fontSize = useCallback(
    () => Math.max(18, Math.round((bitmapRef.current?.width ?? 800) / 32)),
    [],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const bmp = bitmapRef.current;
    if (!canvas || !bmp) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
    const lw = lineWidth();
    const fs = fontSize();
    for (const s of shapes) drawShape(ctx, s, lw, fs);
    if (draft) drawShape(ctx, draft, lw, fs);
  }, [shapes, draft, lineWidth, fontSize]);

  useEffect(() => {
    draw();
  }, [draw, ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // A capture-phase window listener fires before the text input's own
      // onKeyDown ever sees the event — without this guard, Escape while
      // typing a label closes the whole editor (and loses every mark) instead
      // of just cancelling the label.
      if (textEditor) return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, textEditor]);

  function toCanvasPoint(e: { clientX: number; clientY: number }): Point {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!ready) return;
    const p = toCanvasPoint(e);
    if (tool === 'text') {
      // The canvas isn't focusable, so an un-prevented mousedown's default
      // action blurs whatever currently has focus — including the text input
      // this same click is about to mount and autoFocus. Without this, the
      // input gains focus for a single tick and then immediately loses it,
      // firing onBlur with an empty value and discarding the label before a
      // single character can be typed.
      e.preventDefault();
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      setTextEditor({
        x: p.x,
        y: p.y,
        left: e.clientX - (rect?.left ?? 0),
        top: e.clientY - (rect?.top ?? 0),
      });
      return;
    }
    drawingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'box') setDraft({ kind: 'box', x: p.x, y: p.y, w: 0, h: 0, color });
    else if (tool === 'arrow')
      setDraft({ kind: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color });
    else if (tool === 'pen') setDraft({ kind: 'pen', points: [p], color });
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawingRef.current || !draft) return;
    const p = toCanvasPoint(e);
    if (draft.kind === 'box') setDraft({ ...draft, w: p.x - draft.x, h: p.y - draft.y });
    else if (draft.kind === 'arrow') setDraft({ ...draft, x2: p.x, y2: p.y });
    else if (draft.kind === 'pen') setDraft({ ...draft, points: [...draft.points, p] });
  }

  function onPointerUp(): void {
    if (!drawingRef.current || !draft) return;
    drawingRef.current = false;
    setShapes((cur) => [...cur, draft]);
    setDraft(null);
  }

  function commitText(text: string): void {
    if (textEditor && text.trim()) {
      setShapes((cur) => [
        ...cur,
        { kind: 'text', x: textEditor.x, y: textEditor.y, text: text.trim(), color },
      ]);
    }
    setTextEditor(null);
  }

  function undo(): void {
    setShapes((cur) => cur.slice(0, -1));
  }

  async function handleDone(): Promise<void> {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    onDone(new File([blob], `${baseName}-annotated.png`, { type: 'image/png' }));
  }

  return createPortal(
    <div
      className="annotator-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Annotate image"
      data-testid="image-annotator"
    >
      <div className="annotator-toolbar">
        <div className="annotator-tools">
          <button
            type="button"
            className={`annotator-tool${tool === 'box' ? ' active' : ''}`}
            aria-label="Box tool"
            aria-pressed={tool === 'box'}
            onClick={() => setTool('box')}
          >
            <Square size={18} aria-hidden />
          </button>
          <button
            type="button"
            className={`annotator-tool${tool === 'arrow' ? ' active' : ''}`}
            aria-label="Arrow tool"
            aria-pressed={tool === 'arrow'}
            onClick={() => setTool('arrow')}
          >
            <ArrowUpRight size={18} aria-hidden />
          </button>
          <button
            type="button"
            className={`annotator-tool${tool === 'pen' ? ' active' : ''}`}
            aria-label="Freehand tool"
            aria-pressed={tool === 'pen'}
            onClick={() => setTool('pen')}
          >
            <Pencil size={18} aria-hidden />
          </button>
          <button
            type="button"
            className={`annotator-tool${tool === 'text' ? ' active' : ''}`}
            aria-label="Text tool"
            aria-pressed={tool === 'text'}
            onClick={() => setTool('text')}
          >
            <Type size={18} aria-hidden />
          </button>
        </div>
        <div className="annotator-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`annotator-color${color === c ? ' active' : ''}`}
              style={{ background: c }}
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="annotator-actions">
          <button
            type="button"
            className="annotator-undo"
            aria-label="Undo last mark"
            onClick={undo}
            disabled={shapes.length === 0}
          >
            <Undo2 size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="annotator-done"
            data-testid="annotator-done"
            onClick={handleDone}
          >
            <Check size={16} aria-hidden />
            Done
          </button>
          <button
            type="button"
            className="annotator-cancel"
            aria-label="Cancel annotation"
            data-testid="annotator-cancel"
            onClick={onCancel}
          >
            <CloseIcon size={18} />
          </button>
        </div>
      </div>
      <div className="annotator-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="annotator-canvas"
          data-testid="annotator-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {textEditor ? (
          <input
            autoFocus
            className="annotator-text-input"
            data-testid="annotator-text-input"
            style={{ left: textEditor.left, top: textEditor.top, color }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitText(e.currentTarget.value);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setTextEditor(null);
              }
            }}
            onBlur={(e) => commitText(e.currentTarget.value)}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** Toolbar height + canvas-wrap padding, roughly — kept out of the fit box. */
const CHROME_ALLOWANCE = 96;

/** Fit `canvas`'s CSS display size to the viewport, scaling up OR down. */
function applyDisplaySize(canvas: HTMLCanvasElement): void {
  const maxW = window.innerWidth * 0.92;
  const maxH = Math.max(200, window.innerHeight - CHROME_ALLOWANCE) * 0.92;
  const scale = Math.min(maxW / canvas.width, maxH / canvas.height);
  canvas.style.width = `${Math.round(canvas.width * scale)}px`;
  canvas.style.height = `${Math.round(canvas.height * scale)}px`;
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  s: Shape,
  lineWidth: number,
  fontSize: number,
): void {
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.kind === 'box') {
    ctx.strokeRect(s.x, s.y, s.w, s.h);
  } else if (s.kind === 'arrow') {
    drawArrow(ctx, s.x1, s.y1, s.x2, s.y2, lineWidth);
  } else if (s.kind === 'pen') {
    const [first, ...rest] = s.points;
    if (!first || rest.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else {
    ctx.font = `700 ${fontSize}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(s.text, s.x, s.y);
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lineWidth: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(10, lineWidth * 4);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}
