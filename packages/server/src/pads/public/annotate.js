function annotate({ others, cur, n }) {
  const q = (sel) => {
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  };
  // Tom's other edits on this screen, as the editor shows them.
  // In the order they were made: a duplicate inserts an element that later
  // selectors already count.
  let copyOfCur = null;
  for (const c of others) {
    if (c.kind === 'note' || c.kind === 'draw') continue;
    const el = q(c.target.selector);
    if (!el) continue;
    if (c.kind === 'duplicate') {
      const copy = el.cloneNode(true);
      copy.removeAttribute('id');
      el.after(copy);
      if (c.id === cur.id) copyOfCur = copy;
    } else if (c.kind === 'move') el.style.translate = `${c.dx}px ${c.dy}px`;
    else if (c.kind === 'resize') {
      el.style.width = `${c.width}px`;
      el.style.height = `${c.height}px`;
    } else if (c.kind === 'text') el.textContent = c.after;
    else if (c.kind === 'delete' && c.id !== cur.id) el.style.display = 'none';
  }

  const RED = '#e5484d';
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  document.body.appendChild(root);
  const add = (css, text) => {
    const d = document.createElement('div');
    d.style.cssText = css;
    if (text !== undefined) d.textContent = text;
    root.appendChild(d);
    return d;
  };
  const caption = (text) =>
    add(`position:fixed;left:0;right:0;bottom:0;padding:8px 12px;background:rgba(20,16,40,.88);color:#fff;font:600 13px/1.3 system-ui,sans-serif`, text);
  const badge = (x, y) =>
    add(`position:fixed;left:${x - 13}px;top:${y - 13}px;width:26px;height:26px;border-radius:50%;background:${RED};color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);font:700 13px/22px system-ui,sans-serif;text-align:center`, String(n));

  // For a duplicate, the thing to show is the copy.
  const el = cur.kind === 'duplicate' ? copyOfCur : q(cur.target.selector);
  if (!el) {
    caption(`${n}. Couldn't find ${cur.target.label} on this screen any more`);
    return { found: false, needHeight: 0 };
  }
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  // Centre what the change is about, not just its element: the whole stroke,
  // or the note together with what it's pinned to.
  const focus = (rect) => {
    let top = rect.top, bottom = rect.bottom;
    if (cur.kind === 'draw') {
      const ys = cur.points.map((p) => rect.top + p[1]);
      top = Math.min(...ys); bottom = Math.max(...ys);
    } else if (cur.kind === 'note') {
      const ny = rect.top + cur.offset.y;
      // Pinned to something as big as the page (Tom tapped empty space): the
      // note is the point, so frame it, not the whole container.
      if (rect.height > innerHeight * 0.6) { top = ny - 80; bottom = ny + 140; }
      else { top = Math.min(top, ny); bottom = Math.max(bottom, ny + 60); }
    }
    return { top, bottom };
  };
  let f = focus(el.getBoundingClientRect());
  const delta = (f.top + f.bottom) / 2 - innerHeight / 2;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (a === document.documentElement || (/(auto|scroll)/.test(cs.overflowY) && a.scrollHeight > a.clientHeight)) {
      const before = a.scrollTop;
      a.scrollTop += delta;
      if (a.scrollTop !== before) break;
    }
  }
  const r = el.getBoundingClientRect();
  f = focus(r);
  const needHeight = Math.ceil(f.bottom - f.top + 120);
  const box = (rect, style) =>
    add(`position:fixed;left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px;border-radius:6px;box-sizing:border-box;${style}`);

  if (cur.kind === 'move') {
    box({ left: r.left - cur.dx, top: r.top - cur.dy, width: r.width, height: r.height }, `border:2px dashed ${RED};opacity:.8`);
    box(r, `border:3px solid ${RED}`);
  } else if (cur.kind === 'duplicate') {
    box(r, `border:3px dashed ${RED};background:rgba(229,72,77,.08)`);
  } else if (cur.kind === 'delete') {
    box(r, `border:3px solid ${RED};background:repeating-linear-gradient(135deg,rgba(229,72,77,.28) 0 6px,transparent 6px 12px)`);
  } else if (cur.kind === 'note') {
    // Outline what the note is on, unless that's the whole page.
    if (r.height <= innerHeight * 0.6) box(r, 'border:3px solid #f5b800');
    const nx = Math.min(Math.max(4, r.left + cur.offset.x), innerWidth - 230);
    add(`position:fixed;left:${nx}px;top:${r.top + cur.offset.y}px;max-width:220px;background:#ffe27a;color:#3b3000;padding:6px 9px;border-radius:2px 10px 10px 10px;font:500 13px/1.35 system-ui,sans-serif;box-shadow:0 3px 12px rgba(40,30,0,.3);white-space:pre-wrap`, `${n}. ${cur.text}`);
  } else if (cur.kind === 'draw') {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;overflow:visible');
    const pl = document.createElementNS(NS, 'polyline');
    pl.setAttribute('points', cur.points.map((p) => `${r.left + p[0]},${r.top + p[1]}`).join(' '));
    pl.setAttribute('style', `fill:none;stroke:${cur.color};stroke-width:${cur.width};stroke-linecap:round;stroke-linejoin:round`);
    svg.appendChild(pl);
    root.appendChild(svg);
  } else {
    box(r, `border:3px solid ${RED}`);
  }
  if (cur.kind === 'draw') badge(Math.max(14, r.left + cur.points[0][0]), Math.max(14, r.top + cur.points[0][1]));
  else if (cur.kind === 'note' && r.height > innerHeight * 0.6) { /* the note carries its own number */ }
  else badge(Math.max(14, r.left - 4), Math.max(14, r.top - 4));
  return { found: true, needHeight };
}
