// Pad editor. The design runs untouched in an iframe; a transparent layer
// over it owns the pointer, so editing is always on without the design knowing.
// Every change goes to the server at once and every device replays the pending
// ones, so a phone and a laptop looking at the same design see the same thing.
(function () {
  'use strict';

  // Served at /api/padx/<id>/<sig>/ — everything the editor reaches is relative to that.
  var slug = location.pathname.replace(/\/+$/, '').split('/').slice(-2)[0];
  var API = 'api';
  var FRAME_SRC = 'f/';

  var $ = function (id) { return document.getElementById(id); };
  var frame = $('frame'), layer = $('layer'), wrap = $('wrap'), panel = $('panel');
  var narrow = matchMedia('(max-width: 760px)');

  var state = { changes: [], batches: [], screens: [], design: null, rev: null };
  var screen = null;       // the screen the frame is showing; null = somewhere that isn't one
  var tool = 'select';
  var sel = null;          // selected element inside the frame
  var hoverEl = null;
  var drag = null;
  var lastTap = null;
  var editing = null;      // { el, before }
  var sig = '';            // signature of the change list this frame reflects
  var restoring = null;    // scroll positions to put back after a reload
  var notesDirty = true;

  // ---------- small helpers ----------
  function doc() { return frame.contentDocument; }
  function win() { return frame.contentWindow; }
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 2200);
  }
  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || (method + ' ' + path + ' → ' + r.status));
        return d;
      });
    });
  }
  function el(tag, cls, parent) {
    var e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e;
  }
  function local(e) {
    var r = layer.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function hit(pt) {
    var d = doc(); if (!d) return null;
    var t = d.elementFromPoint(pt.x, pt.y);
    if (!t || t === d.documentElement || t === d.body) return null;
    return t;
  }
  function inFrame(node) { return node && doc() && doc().contains(node) && node.isConnected; }

  // ---------- naming elements ----------
  function selectorFor(node) {
    var d = doc(), parts = [];
    var esc = (win().CSS && win().CSS.escape) || function (s) { return s; };
    while (node && node.nodeType === 1 && node !== d.documentElement) {
      if (node.id) { parts.unshift('#' + esc(node.id)); return parts.join(' > '); }
      var i = 1, s = node;
      while ((s = s.previousElementSibling)) if (s.tagName === node.tagName) i++;
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      node = node.parentElement;
    }
    return 'html > ' + parts.join(' > ');
  }
  function labelFor(node) {
    var tag = node.tagName.toLowerCase();
    var id = node.getAttribute('data-testid') ? '[' + node.getAttribute('data-testid') + ']'
      : node.id ? '#' + node.id
      : (typeof node.className === 'string' && node.className.trim()) ? '.' + node.className.trim().split(/\s+/)[0] : '';
    var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return tag + id + (text ? ' "' + (text.length > 40 ? text.slice(0, 40) + '…' : text) + '"' : '');
  }
  function target(node) { return { selector: selectorFor(node), label: labelFor(node), context: contextFor(node) }; }
  /**
   * Where the element sits, in the design's own words: the headings of the
   * sections it is inside, then the row or item it belongs to. A selector
   * finds it; this says what it is.
   */
  function contextFor(node) {
    var d = doc(), parts = [];
    var clean = function (t) { t = (t || '').replace(/\s+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };
    var row = node.closest && node.closest('li, tr, .row, [class*="item"], [class*="card"]');
    if (row && row !== node && row !== d.body) parts.push('"' + clean(row.textContent) + '"');
    for (var a = node.parentElement; a && a !== d.body; a = a.parentElement) {
      var h = a.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > legend, :scope > .label, :scope > [class*="title"], :scope > [class*="head"] h1, :scope > [class*="head"] h2, :scope > [class*="head"] h3');
      if (h && !h.contains(node)) {
        var t = clean(h.textContent);
        if (t && parts.indexOf(t) < 0) parts.push(t);
      }
    }
    return parts.reverse().join(' › ').slice(0, 300);
  }
  function find(selector) { try { return doc().querySelector(selector); } catch (e) { return null; } }

  // ---------- replaying shared changes onto the frame ----------
  // What's on screen: the changes not yet done that belong to the screen shown.
  function live() {
    return state.changes.filter(function (c) { return c.status !== 'done' && screen && c.screen === screen.id; });
  }
  // Replayed in the order they were made: a duplicate inserts an element, so
  // every selector recorded after it assumes the copy is already there, and
  // every one recorded before it assumes it isn't. Copies are rebuilt from
  // scratch each time for the same reason.
  var applying = false;
  function applyPreviews() {
    var d = doc();
    if (!d || !d.body || applying) return;
    applying = true;
    var selDup = sel && sel.getAttribute && sel.getAttribute('data-pad-dup');
    Array.prototype.forEach.call(d.querySelectorAll('[data-pad-dup]'), function (x) { x.remove(); });
    live().forEach(function (c) {
      if (c.kind === 'note' || c.kind === 'draw') return;
      var n = find(c.target.selector); if (!n) return;
      if (c.kind === 'duplicate') {
        var copy = n.cloneNode(true);
        copy.removeAttribute('id');
        copy.setAttribute('data-pad-dup', c.id);
        n.after(copy);
        return;
      }
      if (c.kind === 'move') { var v = c.dx + 'px ' + c.dy + 'px'; if (n.style.translate !== v) n.style.translate = v; }
      else if (c.kind === 'resize') { n.style.width = c.width + 'px'; n.style.height = c.height + 'px'; }
      else if (c.kind === 'text') { if (editing && editing.el === n) return; if (n.textContent !== c.after) n.textContent = c.after; }
      else if (c.kind === 'delete') { if (n.style.display !== 'none') n.style.display = 'none'; }
    });
    if (selDup) sel = d.querySelector('[data-pad-dup="' + selDup + '"]');
    if (observer) observer.takeRecords();
    applying = false;
  }
  function changeSig(list) {
    return list.filter(function (c) { return c.status !== 'done'; })
      .map(function (c) { return c.id + ':' + (c.updatedAt || c.createdAt) + ':' + c.status; }).join('|');
  }

  // ---------- frame lifecycle ----------
  function saveScroll() {
    var d = doc(); if (!d) return null;
    var out = [{ sel: null, top: d.scrollingElement ? d.scrollingElement.scrollTop : 0 }];
    var all = d.querySelectorAll('body *');
    for (var i = 0; i < all.length && i < 4000; i++) {
      if (all[i].scrollTop > 0) out.push({ sel: selectorFor(all[i]), top: all[i].scrollTop });
    }
    return out;
  }
  function screenUrl(s) {
    var parts = s.path.split('#');
    return FRAME_SRC + parts[0] + '?r=' + Date.now() + (parts[1] !== undefined ? '#' + parts[1] : '');
  }
  function reloadFrame() {
    restoring = saveScroll();
    sel = null; hoverEl = null;
    if (screen) frame.src = screenUrl(screen);
    else win().location.reload();
  }

  // ---------- screens ----------
  function screenKey() { return 'pad.screen.' + slug; }
  /** Which listed screen the frame is on, from its own address. */
  function matchScreen() {
    var loc = win().location;
    var base = new URL(FRAME_SRC, location.href).pathname;
    var file = decodeURIComponent(loc.pathname.slice(base.length)) || 'index.html';
    var hash = loc.hash.replace(/^#/, '');
    return state.screens.filter(function (s) {
      var p = s.path.split('#');
      return (p[0] || 'index.html') === file && (p[1] || '') === hash;
    })[0] || null;
  }
  function syncScreen() {
    var found = matchScreen();
    if (found !== screen) {
      if (editing) commitText();
      screen = found; sel = null; hoverEl = null;
      if (screen) { try { localStorage.setItem(screenKey(), screen.id); } catch (e) { /* ignore */ } }
      applyPreviews();
    }
    renderScreens();
    draw();
  }
  function setScreen(s) {
    closeScreenSheet();
    if (s === screen) return;
    screen = s; sel = null; hoverEl = null;
    try { localStorage.setItem(screenKey(), s.id); } catch (e) { /* ignore */ }
    renderScreens(); draw();
    frame.src = screenUrl(s);
  }
  function pendingOn(s) {
    return state.changes.filter(function (c) { return c.status === 'pending' && c.screen === s.id; }).length;
  }
  // Screens added since Tom last opened the Pad carry a dot until he visits them.
  function seenIds() {
    try { var raw = localStorage.getItem('pad.seen.' + slug); return raw === null ? null : JSON.parse(raw); } catch (e) { return null; }
  }
  function markSeen(ids) {
    var seen = seenIds() || [];
    ids.forEach(function (i) { if (seen.indexOf(i) < 0) seen.push(i); });
    try { localStorage.setItem('pad.seen.' + slug, JSON.stringify(seen)); } catch (e) { /* ignore */ }
  }
  // A captured screen keeps the width it was photographed at: the stage scrolls
  // sideways rather than letting the design reflow into a different layout.
  function applyWidth() {
    var w = screen && screen.width;
    wrap.style.minWidth = w && !wrap.classList.contains('phone') ? w + 'px' : '';
  }
  function renderScreens() {
    applyWidth();
    var seen = seenIds();
    if (seen === null && state.screens.length) { markSeen(state.screens.map(function (x) { return x.id; })); seen = seenIds(); }
    if (screen) { markSeen([screen.id]); seen = seenIds(); }
    var nav = $('screens');
    nav.hidden = false;
    $('screenBar').hidden = false;
    nav.textContent = '';
    el('h2', '', nav).textContent = 'Screens';
    state.screens.forEach(function (s) {
      var b = el('button', s === screen ? 'on' : '', nav);
      b.dataset.screen = s.id;
      el('span', '', b).textContent = s.name;
      var n = pendingOn(s);
      if (n) el('b', '', b).textContent = n;
      else if (seen && seen.indexOf(s.id) < 0) el('i', 'new-dot', b).title = 'New screen';
      b.addEventListener('click', function () { setScreen(s); });
    });
    var add = el('button', 'add-screen', nav);
    add.id = 'addScreen'; add.textContent = '+'; add.setAttribute('aria-label', 'Add screen');
    add.addEventListener('click', addScreen);
    var i = state.screens.indexOf(screen);
    $('screenName').textContent = screen ? screen.name : 'Not one of the screens';
    $('prevScreen').disabled = i <= 0;
    $('nextScreen').disabled = i < 0 || i >= state.screens.length - 1;
  }
  function addScreen() {
    closeScreenSheet();
    api('POST', '/screens').then(function (d) {
      return refresh(false).then(function () {
        var made = state.screens.filter(function (x) { return x.id === d.screen.id; })[0];
        if (made) setScreen(made);
      });
    }, fail);
  }
  $('addScreenBar').addEventListener('click', addScreen);
  function closeScreenSheet() { $('screens').classList.remove('open'); }
  $('screenName').addEventListener('click', function () { $('screens').classList.toggle('open'); });
  $('prevScreen').addEventListener('click', function () { var i = state.screens.indexOf(screen); if (i > 0) setScreen(state.screens[i - 1]); });
  $('nextScreen').addEventListener('click', function () { var i = state.screens.indexOf(screen); if (i >= 0 && i < state.screens.length - 1) setScreen(state.screens[i + 1]); });
  var observer = null;
  frame.addEventListener('load', function () {
    var d = doc();
    applyPreviews();
    if (restoring) {
      var r = restoring; restoring = null;
      setTimeout(function () {
        r.forEach(function (s) {
          if (!s.sel) { if (d.scrollingElement) d.scrollingElement.scrollTop = s.top; return; }
          var n = find(s.sel); if (n) n.scrollTop = s.top;
        });
        draw();
      }, 60);
    }
    d.addEventListener('scroll', draw, true);
    win().addEventListener('resize', draw);
    // Designs that render with JS (tabs, routes) swap DOM under us: replay the
    // previews onto whatever they draw, and keep notes pinned to their anchors.
    if (observer) observer.disconnect();
    var queued = false;
    observer = new (win().MutationObserver)(function () {
      if (queued) return; queued = true;
      requestAnimationFrame(function () { queued = false; applyPreviews(); notesDirty = true; draw(); });
    });
    observer.observe(d.documentElement, { subtree: true, childList: true, characterData: true });
    d.addEventListener('keydown', onKey, true);
    // A design that routes with the hash changes screen without a load.
    win().addEventListener('hashchange', syncScreen);
    notesDirty = true;
    syncScreen();
  });

  // ---------- drawing the layer ----------
  var hoverBox = el('div', 'hover', layer), selBox = el('div', 'sel', layer), selLabel = el('div', 'sel-label', layer);
  var handles = ['nw', 'ne', 'sw', 'se'].map(function (pos) {
    var h = el('div', 'handle', layer); h.dataset.pos = pos;
    h.addEventListener('pointerdown', function (e) { startResize(e, pos); });
    return h;
  });
  var delBtn = el('button', 'del', layer); delBtn.textContent = '✕'; delBtn.title = 'Delete (Del)';
  delBtn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  delBtn.addEventListener('click', function (e) { e.stopPropagation(); if (fresh()) return; deleteSelected(); });
  // A tap that selects something makes these buttons appear, and the phone's
  // delayed click for that same tap then lands on whichever is now under the
  // finger. Ignore clicks on a button that has only just appeared.
  var shownFor = null, shownAt = 0, lastPointer = 'mouse';
  function fresh() { return lastPointer !== 'mouse' && Date.now() - shownAt < 450; }
  var marquee = el('div', 'marquee', layer);
  var strokesLayer = el('div', 'strokes', layer);
  var notesLayer = el('div', 'notes', layer);

  function place(box, r) {
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }
  function draw() {
    var showSel = tool === 'select' && sel && inFrame(sel) && !editing;
    if (sel && !inFrame(sel)) sel = null;
    hoverBox.style.display = (tool === 'select' && hoverEl && hoverEl !== sel && inFrame(hoverEl) && !drag) ? 'block' : 'none';
    if (hoverBox.style.display === 'block') place(hoverBox, hoverEl.getBoundingClientRect());
    [selBox, selLabel, delBtn].concat(handles).forEach(function (n) { n.style.display = showSel ? 'block' : 'none'; });
    if (showSel) {
      var r = sel.getBoundingClientRect();
      place(selBox, r);
      selLabel.textContent = labelFor(sel);
      selLabel.style.left = r.left + 'px'; selLabel.style.top = Math.max(r.top, 18) + 'px';
      var pts = { nw: [r.left, r.top], ne: [r.right, r.top], sw: [r.left, r.bottom], se: [r.right, r.bottom] };
      handles.forEach(function (h) { var p = pts[h.dataset.pos]; h.style.left = p[0] + 'px'; h.style.top = p[1] + 'px'; });
      // Actions sit just outside the selection, never over it, so they are
      // not under the finger that made the selection.
      var gap = delBtn.offsetWidth / 2 + 6;
      var actionsY = r.top - gap >= gap ? r.top - gap : r.bottom + gap;
      delBtn.style.left = (r.right - gap + 6) + 'px'; delBtn.style.top = actionsY + 'px';
      if (shownFor !== sel) { shownFor = sel; shownAt = Date.now(); }
    } else {
      shownFor = null;
    }
    drawNotes();
  }

  var noteEls = {};
  function drawNotes() {
    var notes = live().filter(function (c) { return c.kind === 'note'; });
    var keep = {};
    notes.forEach(function (c) {
      keep[c.id] = true;
      var n = noteEls[c.id];
      if (!n) {
        n = noteEls[c.id] = el('div', 'note', notesLayer);
        n.dataset.id = c.id;
        var body = el('span', 'body', n);
        var x = el('button', 'x', n); x.textContent = '✕'; x.title = 'Remove note';
        x.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        x.addEventListener('click', function (e) { e.stopPropagation(); removeChange(c.id); });
        n.addEventListener('pointerdown', function (e) { startNoteDrag(e, n); });
      }
      n.classList.toggle('sent', c.status === 'sent');
      n.querySelector('.x').style.display = c.status === 'pending' ? '' : 'none';
      var b = n.querySelector('.body'); if (b.textContent !== c.text && !n.querySelector('textarea')) b.textContent = c.text;
      var anchor = find(c.target.selector);
      // Anchored to something this view isn't showing (another tab of a JS
      // design): hide it rather than pin it somewhere it doesn't belong.
      n.style.display = anchor ? '' : 'none';
      var ar = anchor ? anchor.getBoundingClientRect() : { left: 0, top: 0 };
      if (!(drag && drag.note === n)) {
        // Keep the whole note on screen: one pinned near the right edge used to
        // shrink to a column one word wide.
        var room = layer.clientWidth - n.offsetWidth - 4;
        n.style.left = Math.max(4, Math.min(ar.left + c.offset.x, room)) + 'px';
        n.style.top = (ar.top + c.offset.y) + 'px';
      }
    });
    Object.keys(noteEls).forEach(function (id) {
      if (!keep[id]) { noteEls[id].remove(); delete noteEls[id]; }
    });
    drawStrokes();
    notesDirty = false;
  }

  var strokeEls = {};
  var SVGNS = 'http://www.w3.org/2000/svg';
  function strokeSvg(points, color, width) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(function (p) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); });
    var pad = width + 2;
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'stroke');
    svg.setAttribute('width', maxX - minX + pad * 2); svg.setAttribute('height', maxY - minY + pad * 2);
    var pl = document.createElementNS(SVGNS, 'polyline');
    pl.setAttribute('points', points.map(function (p) { return (p[0] - minX + pad) + ',' + (p[1] - minY + pad); }).join(' '));
    pl.setAttribute('stroke', color); pl.setAttribute('stroke-width', width);
    svg.appendChild(pl);
    svg._origin = { x: minX - pad, y: minY - pad };
    return svg;
  }
  function drawStrokes() {
    var keep = {};
    live().filter(function (c) { return c.kind === 'draw'; }).forEach(function (c) {
      keep[c.id] = true;
      var svg = strokeEls[c.id];
      if (!svg) { svg = strokeEls[c.id] = strokeSvg(c.points, c.color, c.width); strokesLayer.appendChild(svg); }
      svg.classList.toggle('sent', c.status === 'sent');
      var anchor = find(c.target.selector);
      svg.style.display = anchor ? '' : 'none';
      if (!anchor) return;
      var ar = anchor.getBoundingClientRect();
      svg.style.left = (ar.left + svg._origin.x) + 'px'; svg.style.top = (ar.top + svg._origin.y) + 'px';
    });
    Object.keys(strokeEls).forEach(function (id) {
      if (!keep[id]) { strokeEls[id].remove(); delete strokeEls[id]; }
    });
  }



  // ---------- modes and tools ----------
  // View: the design works as itself (taps navigate). Edit: Select or Note.
  var editTool = 'select';
  function setMode(m) {
    document.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === m); });
    $('editTools').hidden = m !== 'edit';
    try { localStorage.setItem('pad.mode', m); } catch (e) { /* private mode */ }
    if (m === 'view') { sel = null; setTool('interact'); } else setTool(editTool);
  }
  document.querySelectorAll('[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.dataset.mode); });
  });
  function setTool(t) {
    if (editing) commitText();
    tool = t;
    if (t !== 'interact') editTool = t;
    document.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === t); });
    layer.classList.toggle('interact', t === 'interact');
    layer.classList.toggle('text-tool', t === 'text');
    layer.classList.toggle('draw-tool', t === 'draw');
    if (t !== 'select') hoverEl = null;
    draw();
  }
  document.querySelectorAll('[data-tool]').forEach(function (b) {
    b.addEventListener('click', function () { setTool(b.dataset.tool); });
  });

  function setDevice(dv) {
    wrap.classList.toggle('phone', dv === 'phone');
    applyWidth();
    document.querySelectorAll('[data-device]').forEach(function (b) { b.classList.toggle('on', b.dataset.device === dv); });
    try { localStorage.setItem('pad.device.' + slug, dv); } catch (e) { /* private mode */ }
    setTimeout(draw, 50);
  }
  document.querySelectorAll('[data-device]').forEach(function (b) {
    b.addEventListener('click', function () { setDevice(b.dataset.device); });
  });

  // ---------- pointer on the layer ----------
  function scrollerFor(node) {
    var d = doc();
    while (node && node !== d.body && node !== d.documentElement) {
      var cs = win().getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) &&
          (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) return node;
      node = node.parentElement;
    }
    return d.scrollingElement || d.documentElement;
  }
  function currentTranslate(node) {
    var m = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(node.style.translate || '');
    if (m) return { x: +m[1], y: +m[2] };
    var one = /(-?[\d.]+)px/.exec(node.style.translate || '');
    return one ? { x: +one[1], y: 0 } : { x: 0, y: 0 };
  }

  layer.addEventListener('pointerdown', function (e) {
    if (tool === 'interact' || e.button > 0) return;
    lastPointer = e.pointerType;
    if (e.target.closest('.note, .handle, .del')) return;
    if (!screen) { toast('This view isn’t one of the screens. Pick one from the list to edit it.', 3500); return; }
    var pt = local(e);
    if (tool === 'text') { e.preventDefault(); startNote(pt); return; }
    if (tool === 'draw') { e.preventDefault(); startStroke(e, pt); return; }
    var t = hit(pt);
    var onSel = sel && t && (t === sel || sel.contains(t));
    drag = {
      mode: onSel ? 'press-sel' : 'press', el: onSel ? sel : t, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY,
      id: e.pointerId, base: onSel ? currentTranslate(sel) : null, scroller: scrollerFor(t),
    };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener('pointermove', function (e) {
    if (tool === 'interact' || (drag && drag.stroke)) return;
    if (!drag) {
      if (e.pointerType === 'mouse' && tool === 'select') { hoverEl = hit(local(e)); draw(); }
      return;
    }
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0, far = Math.abs(dx) + Math.abs(dy);
    if (drag.mode === 'press-sel' && far > 4) drag.mode = 'move';
    if (drag.mode === 'press' && far > 6) drag.mode = e.pointerType === 'mouse' && tool === 'select' ? 'marquee' : 'pan';
    if (drag.mode === 'marquee') {
      var a = local({ clientX: drag.x0, clientY: drag.y0 }), b = local(e);
      place(marquee, { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
      marquee.style.display = 'block';
      return;
    }
    if (drag.mode === 'move') {
      drag.el.style.translate = (drag.base.x + dx) + 'px ' + (drag.base.y + dy) + 'px';
      draw();
    } else if (drag.mode === 'pan') {
      drag.scroller.scrollBy(drag.lx - e.clientX, drag.ly - e.clientY);
      drag.lx = e.clientX; drag.ly = e.clientY;
    }
  });
  function endPointer(e) {
    if (!drag || drag.resize || drag.note || drag.stroke) return;
    var d = drag; drag = null;
    if (d.mode === 'marquee') {
      marquee.style.display = 'none';
      var a = local({ clientX: d.x0, clientY: d.y0 }), b = local(e);
      sel = enclosed({ l: Math.min(a.x, b.x), t: Math.min(a.y, b.y), r: Math.max(a.x, b.x), b: Math.max(a.y, b.y) }) || d.el || null;
      draw();
      return;
    }
    if (d.mode === 'move') {
      var dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      post({ kind: 'move', target: target(d.el), dx: Math.round(d.base.x + dx), dy: Math.round(d.base.y + dy) });
    } else if (d.mode === 'press' || d.mode === 'press-sel') {
      var t = d.el, now = Date.now();
      if (t && lastTap && lastTap.el === t && now - lastTap.t < 380) { lastTap = null; editText(t); return; }
      lastTap = { el: t, t: now };
      sel = t || null;
      draw();
    }
    draw();
  }
  // The smallest element containing everything that sits whole inside the box;
  // never the page itself.
  function enclosed(box) {
    var d = doc(), whole = [];
    Array.prototype.forEach.call(d.body.querySelectorAll('*'), function (n) {
      var r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.left < box.l || r.top < box.t || r.right > box.r || r.bottom > box.b) return;
      if (win().getComputedStyle(n).display === 'none') return;
      whole.push(n);
    });
    if (!whole.length) return null;
    var top = whole.filter(function (n) { return !whole.some(function (o) { return o !== n && o.contains(n); }); });
    var common = top[0];
    while (common && common !== d.body && !top.every(function (n) { return common.contains(n); })) common = common.parentElement;
    return common && common !== d.body ? common : null;
  }
  layer.addEventListener('pointerup', endPointer);
  layer.addEventListener('pointercancel', function () { if (drag && drag.stroke) return; drag = null; marquee.style.display = 'none'; draw(); });
  layer.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !drag) { hoverEl = null; draw(); } });
  layer.addEventListener('wheel', function (e) {
    if (tool === 'interact') return;
    e.preventDefault();
    scrollerFor(hit(local(e))).scrollBy(e.deltaX, e.deltaY);
  }, { passive: false });

  // ---------- draw ----------
  var PEN = { color: '#e5484d', width: 3 };
  function startStroke(e, pt) {
    var pts = [[Math.round(pt.x), Math.round(pt.y)]];
    var wet = document.createElementNS(SVGNS, 'svg');
    wet.setAttribute('class', 'stroke wet');
    var pl = document.createElementNS(SVGNS, 'polyline');
    pl.setAttribute('stroke', PEN.color); pl.setAttribute('stroke-width', PEN.width);
    wet.appendChild(pl); strokesLayer.appendChild(wet);
    var paint = function () { pl.setAttribute('points', pts.map(function (p) { return p.join(','); }).join(' ')); };
    paint();
    layer.setPointerCapture(e.pointerId);
    drag = { stroke: true };
    var move = function (ev) {
      var q = local(ev), last = pts[pts.length - 1];
      if (Math.abs(q.x - last[0]) + Math.abs(q.y - last[1]) < 2 || pts.length >= 1500) return;
      pts.push([Math.round(q.x), Math.round(q.y)]); paint();
    };
    var up = function () {
      layer.removeEventListener('pointermove', move); layer.removeEventListener('pointerup', up); layer.removeEventListener('pointercancel', up);
      drag = null;
      if (pts.length < 2) { wet.remove(); return; }
      // Anchor to what the stroke is around, so it scrolls with it.
      var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
      var mid = { x: (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, y: (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2 };
      var anchor = hit(mid) || doc().body, ar = anchor.getBoundingClientRect();
      var over = [], seen = [];
      for (var i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 40))) {
        var n = hit({ x: pts[i][0], y: pts[i][1] });
        if (n && seen.indexOf(n) < 0 && over.length < 8) { seen.push(n); over.push(labelFor(n)); }
      }
      post({
        kind: 'draw', target: target(anchor), color: PEN.color, width: PEN.width, over: over,
        points: pts.map(function (p) { return [Math.round(p[0] - ar.left), Math.round(p[1] - ar.top)]; }),
      }).then(function () { wet.remove(); });
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  }

  // ---------- resize ----------
  function startResize(e, pos) {
    e.preventDefault(); e.stopPropagation();
    if (!sel) return;
    var r = sel.getBoundingClientRect();
    drag = { resize: true, el: sel, pos: pos, x0: e.clientX, y0: e.clientY, w: r.width, h: r.height };
    e.target.setPointerCapture(e.pointerId);
    var move = function (ev) {
      var sx = (pos === 'ne' || pos === 'se') ? 1 : -1, sy = (pos === 'sw' || pos === 'se') ? 1 : -1;
      drag.nw = Math.max(4, drag.w + (ev.clientX - drag.x0) * sx);
      drag.nh = Math.max(4, drag.h + (ev.clientY - drag.y0) * sy);
      drag.el.style.width = Math.round(drag.nw) + 'px'; drag.el.style.height = Math.round(drag.nh) + 'px';
      draw();
    };
    var up = function () {
      e.target.removeEventListener('pointermove', move); e.target.removeEventListener('pointerup', up);
      var d = drag; drag = null;
      if (d.nw) post({ kind: 'resize', target: target(d.el), fromWidth: Math.round(d.w), fromHeight: Math.round(d.h), width: Math.round(d.nw), height: Math.round(d.nh) });
      draw();
    };
    e.target.addEventListener('pointermove', move);
    e.target.addEventListener('pointerup', up);
  }

  // ---------- text ----------
  function editText(node) {
    if (!node) return;
    sel = node;
    editing = { el: node, before: node.textContent };
    layer.classList.add('editing');
    node.setAttribute('contenteditable', 'plaintext-only');
    if (node.contentEditable !== 'plaintext-only') node.setAttribute('contenteditable', 'true');
    node.focus();
    var range = doc().createRange(); range.selectNodeContents(node);
    var s = win().getSelection(); s.removeAllRanges(); s.addRange(range);
    node.addEventListener('blur', commitText, { once: true });
    draw();
  }
  function commitText(cancel) {
    if (!editing) return;
    var ed = editing; editing = null;
    layer.classList.remove('editing');
    ed.el.removeAttribute('contenteditable');
    if (cancel === true) ed.el.textContent = ed.before;
    var after = ed.el.textContent;
    if (after !== ed.before) post({ kind: 'text', target: target(ed.el), before: ed.before, after: after });
    draw();
  }

  // ---------- delete ----------
  function deleteSelected() {
    if (!sel) return;
    var t = target(sel);
    sel.style.display = 'none';
    sel = null; draw();
    post({ kind: 'delete', target: t });
  }

  // ---------- notes ----------
  function startNote(pt) {
    var anchor = hit(pt) || doc().body;
    var ar = anchor.getBoundingClientRect();
    var n = el('div', 'note draft', notesLayer);
    n.style.left = pt.x + 'px'; n.style.top = pt.y + 'px';
    var ta = el('textarea', 'note-draft', n); ta.placeholder = 'Write a note';
    var done = false;
    var finish = function (save) {
      if (done) return; done = true;
      var text = ta.value.trim(); n.remove();
      if (save && text) {
        post({ kind: 'note', target: target(anchor), text: text, offset: { x: Math.round(pt.x - ar.left), y: Math.round(pt.y - ar.top) } });
      }
      setTool('select');
    };
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    ta.addEventListener('blur', function () { finish(true); });
    n.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    // Focus inside the tap itself: a deferred focus loses the first keystrokes,
    // and phones only raise the keyboard for a focus made during the gesture.
    ta.focus();
  }
  function startNoteDrag(e, n) {
    if (e.target.closest('textarea')) return;
    e.preventDefault(); e.stopPropagation();
    var c = state.changes.filter(function (x) { return x.id === n.dataset.id; })[0];
    if (!c) return;
    var x0 = e.clientX, y0 = e.clientY, l0 = parseFloat(n.style.left), t0 = parseFloat(n.style.top);
    drag = { note: n };
    n.setPointerCapture(e.pointerId);
    var moved = false;
    var move = function (ev) {
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 4) moved = true;
      n.style.left = (l0 + ev.clientX - x0) + 'px'; n.style.top = (t0 + ev.clientY - y0) + 'px';
    };
    var up = function (ev) {
      n.removeEventListener('pointermove', move); n.removeEventListener('pointerup', up);
      drag = null;
      if (c.status !== 'pending') { draw(); return; }
      if (moved) {
        var off = { x: c.offset.x + Math.round(ev.clientX - x0), y: c.offset.y + Math.round(ev.clientY - y0) };
        c.offset = off;
        ownPending = true;
        api('PATCH', '/changes/' + c.id, { offset: off }).then(function () { return refresh(); }).catch(fail);
      } else {
        editNote(n, c);
      }
    };
    n.addEventListener('pointermove', move);
    n.addEventListener('pointerup', up);
  }
  function editNote(n, c) {
    var body = n.querySelector('.body');
    var ta = el('textarea', 'note-draft'); ta.value = c.text;
    body.textContent = ''; body.appendChild(ta);
    ta.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    var done = false;
    var finish = function (save) {
      if (done) return; done = true;
      var text = ta.value.trim(); ta.remove(); body.textContent = c.text;
      if (save && text && text !== c.text) { c.text = text; body.textContent = text; ownPending = true; api('PATCH', '/changes/' + c.id, { text: text }).then(function () { return refresh(); }).catch(fail); }
    };
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    ta.addEventListener('blur', function () { finish(true); });
    ta.focus();
  }

  // ---------- keyboard ----------
  function onKey(e) {
    var typing = editing || (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName));
    if (editing && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editing.el.blur(); return; }
    if (editing && e.key === 'Escape') { e.preventDefault(); var n = editing.el; commitText(true); n.blur(); return; }
    var mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (typing) return;
    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
      else if (k === 'd' && sel && tool === 'select') duplicateSelected();
      else if (k === 'enter') $('send').click();
      else return;
      e.preventDefault(); return;
    }
    if (e.altKey) return;
    var editingOn = tool !== 'interact';
    if (k === '?' || (k === '/' && e.shiftKey)) toggleHelp();
    else if (k === 'escape') { if (!$('help').hidden) toggleHelp(false); else { sel = null; draw(); } }
    else if (k === 'e') setMode(tool === 'interact' ? 'edit' : 'view');
    else if (k === 'v' && editingOn) setTool('select');
    else if ((k === 'n' || k === 't') && editingOn) setTool('text');
    else if (k === 'd' && editingOn) setTool('draw');
    else if (k === 'pageup' || k === 'pagedown') { var i = state.screens.indexOf(screen) + (k === 'pageup' ? -1 : 1); if (state.screens[i]) setScreen(state.screens[i]); }
    else if (!(sel && tool === 'select')) return;
    else if (k === 'delete' || k === 'backspace') deleteSelected();
    else if (k.indexOf('arrow') === 0) nudge(k, e.shiftKey ? 10 : 1);
    else if (k === 'enter' && e.shiftKey) selectRelative('parent');
    else if (k === 'enter') editText(sel);
    else if (k === 'tab') selectRelative(e.shiftKey ? 'prev' : 'next');
    else return;
    e.preventDefault();
  }

  // ---------- keyboard actions ----------
  function duplicateSelected() {
    var src = sel;
    post({ kind: 'duplicate', target: target(src) }).then(function () {
      // The copy is the element right after the original once replayed.
      var copy = src.nextElementSibling;
      if (copy && copy.getAttribute('data-pad-dup')) { sel = copy; draw(); }
    });
  }
  var nudgeTimer = null;
  function nudge(k, step) {
    var base = currentTranslate(sel);
    var dx = base.x + (k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0);
    var dy = base.y + (k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
    sel.style.translate = dx + 'px ' + dy + 'px';
    draw();
    // A run of key presses is one move, saved when the keys go quiet.
    var node = sel;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(function () { post({ kind: 'move', target: target(node), dx: Math.round(dx), dy: Math.round(dy) }); }, 350);
  }
  function selectRelative(which) {
    var d = doc(), n = sel;
    var visible = function (x) { return x && x.getClientRects().length > 0; };
    if (which === 'parent') { n = sel.parentElement; if (!n || n === d.body || n === d.documentElement) return; }
    else {
      do { n = which === 'next' ? n.nextElementSibling : n.previousElementSibling; } while (n && !visible(n));
      if (!n) return;
    }
    sel = n;
    var r = n.getBoundingClientRect();
    if (r.bottom < 0 || r.top > layer.clientHeight) n.scrollIntoView({ block: 'center' });
    draw();
  }

  function toggleHelp(open) {
    var h = $('help');
    h.hidden = open === undefined ? !h.hidden : !open;
  }
  document.addEventListener('keydown', onKey, true);

  // ---------- server state ----------
  function fail(err) { toast(err.message, 5000); }
  // What this page just did is already on screen, so its own refresh must not
  // reload the frame; a change list altered anywhere else must.
  var ownPending = false;
  function post(change) {
    if (!screen) { fail(new Error('Pick a screen before editing')); return Promise.resolve(); }
    change.screen = screen.id;
    // The size Tom was looking at, so the chat's picture is drawn the same.
    change.viewport = { w: layer.clientWidth, h: layer.clientHeight };
    ownPending = true;
    return api('POST', '/changes', change).then(function () { return refresh(); }).catch(fail);
  }
  /** Take back the newest pending change on this screen, whoever made it: the list is shared. */
  var redoStack = [];
  function undo() {
    var pending = live().filter(function (c) { return c.status === 'pending'; });
    if (!pending.length) return;
    var last = pending[pending.length - 1];
    redoStack.push({ screen: last.screen, change: last });
    removeChange(last.id);
  }
  function redo() {
    var top = redoStack[redoStack.length - 1];
    if (!top || !screen || top.screen !== screen.id) return;
    redoStack.pop();
    var c = JSON.parse(JSON.stringify(top.change));
    ['id', 'status', 'createdAt', 'updatedAt', 'batch', 'screen'].forEach(function (f) { delete c[f]; });
    post(c).then(function () { reloadFrame(); });
  }
  function removeChange(id) {
    api('DELETE', '/changes/' + id).then(function () { return refresh(true); }, fail);
  }
  function refresh(forceReload) {
    return api('GET', '').then(function (d) {
      var prevRev = state.rev;
      state = d;
      // Every refresh brings a fresh list: keep pointing at the same screen by id.
      if (screen) screen = d.screens.filter(function (s) { return s.id === screen.id; })[0] || null;
      $('name').textContent = d.design.name;
      try { window.parent.postMessage({ type: 'pad:state', id: d.design.id, name: d.design.name, pending: d.changes.filter(function (c) { return c.status === 'pending'; }).length, working: d.design.working }, '*'); } catch (e) { /* standalone frame */ }
      document.title = d.design.name + ' · Pad';
      var s = changeSig(d.changes);
      var own = ownPending; ownPending = false;
      var elsewhere = sig && s !== sig && !own;
      sig = s;
      if ((prevRev !== null && d.rev !== prevRev) || forceReload === true || elsewhere) reloadFrame();
      else applyPreviews();
      renderPanel();
      renderScreens();
      draw();
    });
  }
  var KIND = { move: 'Move', resize: 'Size', text: 'Text', delete: 'Delete', note: 'Note', draw: 'Draw', duplicate: 'Copy' };
  function describe(c) {
    var on = c.target.label;
    if (c.kind === 'move') return on + ' moved ' + phrase(c.dx, c.dy);
    if (c.kind === 'resize') return on + ' → ' + c.width + '×' + c.height;
    if (c.kind === 'text') return '"' + c.before.trim().slice(0, 40) + '" → "' + c.after.trim().slice(0, 60) + '"';
    if (c.kind === 'delete' || c.kind === 'duplicate') return on;
    if (c.kind === 'draw') return 'on ' + on;
    return c.text;
  }
  function phrase(dx, dy) {
    var p = [];
    if (dx) p.push(Math.abs(dx) + 'px ' + (dx > 0 ? 'right' : 'left'));
    if (dy) p.push(Math.abs(dy) + 'px ' + (dy > 0 ? 'down' : 'up'));
    return p.join(', ') || 'back';
  }
  function renderPanel() {
    var pending = state.changes.filter(function (c) { return c.status === 'pending'; });
    var ol = $('pending'); ol.textContent = '';
    var many = state.screens.length > 1, lastScreen;
    state.screens.map(function (x) { return x.id; }).concat([null]).forEach(function (sid) {
      pending.filter(function (c) { return sid === null ? !state.screens.some(function (x) { return x.id === c.screen; }) : c.screen === sid; })
        .forEach(function (c) { draw1(c, sid); });
    });
    function draw1(c, sid) {
      if (many && sid !== lastScreen) {
        lastScreen = sid;
        var s = state.screens.filter(function (x) { return x.id === sid; })[0];
        var h = el('li', 'screen-head', ol);
        var b = el('button', '', h); b.textContent = s ? s.name : 'Screen no longer in the design';
        if (s) b.addEventListener('click', function () { setScreen(s); if (narrow.matches) togglePanel(false); });
      }
      var li = el('li', '', ol);
      el('span', 'k', li).textContent = KIND[c.kind];
      el('span', '', li).textContent = describe(c);
      var x = el('button', '', li); x.textContent = '✕'; x.title = 'Undo this';
      x.addEventListener('click', function () { removeChange(c.id); });
    }
    var count = $('count'); count.textContent = pending.length; count.classList.toggle('has', pending.length > 0);
    $('send').disabled = pending.length === 0 || sending;
    var hist = $('history'); hist.textContent = '';
    var batches = state.batches.slice().reverse();
    $('histTitle').hidden = batches.length === 0;
    batches.forEach(function (b) {
      var li = el('li', '', hist);
      var when = new Date(b.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el('span', 'meta', li).textContent = (b.changeIds.length ? b.changeIds.length + ' change' + (b.changeIds.length === 1 ? '' : 's') + ' · ' : '') + when;
      if (b.pictures && b.pictures.length) {
        var pics = el('span', 'pics', li);
        b.pictures.forEach(function (pic) {
          var a = el('a', '', pics); a.href = 'pictures/' + encodeURIComponent(pic.name); a.target = '_blank';
          var img = el('img', '', a); img.src = a.href; img.alt = 'Picture sent with changes ' + pic.numbers.join(', ');
        });
      }
      if (b.reply) el('span', 'reply', li).textContent = b.reply;
      else el('span', 'waiting', li).textContent = 'Waiting for the chat';
    });
  }

  var sending = false;
  $('send').addEventListener('click', function () {
    if (editing) commitText();
    sending = true; renderPanel();
    $('sendErr').hidden = true;
    api('POST', '/send').then(function () {
      sending = false; toast('Sent to the chat');
      return refresh();
    }, function (err) {
      sending = false; renderPanel();
      $('sendErr').textContent = err.message; $('sendErr').hidden = false;
    });
  });

  function togglePanel(open) {
    panel.hidden = open === undefined ? !panel.hidden : !open;
    try { localStorage.setItem('pad.panel', panel.hidden ? '0' : '1'); } catch (e) { /* ignore */ }
    setTimeout(draw, 50);
  }
  $('panelBtn').addEventListener('click', function () { togglePanel(); });
  $('panelClose').addEventListener('click', function () { togglePanel(false); });

  // ---------- boot ----------
  var savedDevice = null, savedPanel = null;
  try { savedDevice = localStorage.getItem('pad.device.' + slug); savedPanel = localStorage.getItem('pad.panel'); } catch (e) { /* ignore */ }
  // The Pad says how it opens (Desktop or Phone); a device Tom picked for this Pad wins.
  setDevice(savedDevice || 'desktop');
  panel.hidden = narrow.matches ? true : savedPanel === '0';
  var savedMode = null;
  try { savedMode = localStorage.getItem('pad.mode'); } catch (e) { /* ignore */ }
  setMode(savedMode === 'view' ? 'view' : 'edit');
  window.addEventListener('resize', draw);
  refresh().then(function () {
    if (!savedDevice) setDevice(state.device === 'phone' ? 'phone' : 'desktop');
    var saved = null;
    try { saved = localStorage.getItem(screenKey()); } catch (e) { /* ignore */ }
    screen = state.screens.filter(function (s) { return s.id === saved; })[0] || state.screens[0];
    renderScreens();
    frame.src = screenUrl(screen);
  }, function (err) { toast(err.message, 8000); });
  // A dropped poll is retried; three in a row means the link is really down.
  var misses = 0;
  setInterval(function () {
    refresh().then(function () { misses = 0; }, function (err) {
      if (++misses === 3) toast('Lost the connection to Pad: ' + err.message, 6000);
    });
  }, 1500);
})();
