(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const DURATION = 400;
  const STYLES = {
    core: { radius: 9, color: '#ffd166' },
    important: { radius: 7, color: '#c79bff' },
    fact: { radius: 6, color: '#5ed3ff' },
    trivia: { radius: 5, color: '#8ea0b8' }
  };

  let canvas = null, ctx = null, observer = null, frameId = 0;
  let width = 1, height = 1, pixelRatio = 1, dust = null, background = null;
  let nodes = [], groups = [], edges = [], bounds = null, transitionStart = 0;
  let onPick = null, saved = null, pointer = null, hovered = null, tooltip = null;
  const camera = { x: 0, y: 0, scale: 1 };
  const pointers = new Map();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (from, to, t) => from + (to - from) * t;

  function advance(now) {
    const t = clamp((now - transitionStart) / DURATION, 0, 1);
    const ease = t * t * (3 - 2 * t);
    for (const item of nodes) {
      item.x = lerp(item.fromX, item.toX, ease);
      item.y = lerp(item.fromY, item.toY, ease);
      item.alpha = lerp(item.fromAlpha, item.toAlpha, ease);
    }
    for (const group of groups) {
      group.x = lerp(group.fromX, group.toX, ease);
      group.y = lerp(group.fromY, group.toY, ease);
      group.radius = lerp(group.fromRadius, group.toRadius, ease);
    }
  }

  function update(nextNodes, nextEdges) {
    if (!canvas) return;
    if (!Array.isArray(nextNodes) || !Array.isArray(nextEdges)) {
      throw new TypeError('MemoryGalaxy.update expects node and edge arrays');
    }
    const now = performance.now();
    advance(now); // Rapid updates start from the positions currently on screen.
    const previous = new Map(nodes.map(item => [item.data.index, item]));
    const previousGroups = new Map(groups.map(group => [group.key, group]));
    const grouped = new Map();
    for (const data of nextNodes) {
      if (!grouped.has(data.group)) {
        grouped.set(data.group, { key: data.group, name: String(data.group ?? ''), owner: false, items: [], radius: 0 });
      }
      const group = grouped.get(data.group);
      const style = STYLES[data.kind] || STYLES.fact;
      const i = group.items.length;
      const r = 34 * Math.sqrt(i);
      group.items.push({ data, ...style, localX: Math.cos(i * GOLDEN_ANGLE) * r, localY: Math.sin(i * GOLDEN_ANGLE) * r });
      group.radius = Math.max(group.radius, r + style.radius);
      group.owner = group.owner || !!data.isOwnerGroup;
    }

    groups = Array.from(grouped.values());
    ctx.font = '600 14px system-ui, "Microsoft YaHei", sans-serif';
    let halfWidth = 0, halfHeight = 0;
    for (const group of groups) {
      group.outer = group.radius + (group.owner ? 40 : 14);
      group.halfWidth = Math.max(group.outer, ctx.measureText(group.name).width / 2);
      halfWidth = Math.max(halfWidth, group.halfWidth);
      halfHeight = Math.max(halfHeight, group.outer + 34);
    }
    const columns = Math.ceil(Math.sqrt(groups.length));
    const rows = Math.ceil(groups.length / columns);
    bounds = groups.length ? { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity } : null;
    nodes = [];
    groups.forEach((group, i) => {
      const row = Math.floor(i / columns);
      const rowCount = Math.min(columns, groups.length - row * columns);
      const x = (i % columns - (rowCount - 1) / 2) * (halfWidth * 2 + 90);
      const y = (row - (rows - 1) / 2) * (halfHeight * 2 + 60);
      const old = previousGroups.get(group.key);
      group.fromX = group.x = old ? old.x : x;
      group.fromY = group.y = old ? old.y : y;
      group.toX = x;
      group.toY = y;
      group.toRadius = group.radius;
      group.fromRadius = group.radius = old ? old.radius : group.radius;
      bounds.left = Math.min(bounds.left, x - group.halfWidth);
      bounds.right = Math.max(bounds.right, x + group.halfWidth);
      bounds.top = Math.min(bounds.top, y - group.outer - 34);
      bounds.bottom = Math.max(bounds.bottom, y + group.outer);
      for (const item of group.items) {
        const prior = previous.get(item.data.index);
        item.fromX = item.x = prior ? prior.x : group.fromX;
        item.fromY = item.y = prior ? prior.y : group.fromY;
        item.toX = x + item.localX;
        item.toY = y + item.localY;
        item.fromAlpha = item.alpha = prior ? prior.alpha : 0;
        item.toAlpha = 0.4 + 0.6 * clamp(Number.isFinite(item.data.score) ? item.data.score : 0, 0, 15) / 15;
        nodes.push(item);
      }
      delete group.items;
    });
    const byIndex = new Map(nodes.map(item => [item.data.index, item]));
    edges = nextEdges.filter(edge => byIndex.has(edge.from) && byIndex.has(edge.to)).map(edge => ({
      from: byIndex.get(edge.from), to: byIndex.get(edge.to), kind: edge.kind
    }));
    transitionStart = now;
    hovered = null;
    tooltip = null;
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, rect.width);
    const nextHeight = Math.max(1, rect.height);
    const ratio = window.devicePixelRatio || 1;
    if (dust && width === nextWidth && height === nextHeight && pixelRatio === ratio) return;
    const wasHidden = width <= 1 || height <= 1;
    width = nextWidth;
    height = nextHeight;
    pixelRatio = ratio;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    // Keep intrinsic-only canvases from growing repeatedly on high-DPI displays.
    const resized = canvas.getBoundingClientRect();
    if (Math.abs(resized.width - width) > 0.5) canvas.style.width = width + 'px';
    if (Math.abs(resized.height - height) > 0.5) canvas.style.height = height + 'px';
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    background = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.hypot(width, height) / 2);
    background.addColorStop(0, '#05080f');
    background.addColorStop(1, '#0a1020');
    dust = document.createElement('canvas');
    dust.width = Math.ceil((width + 48) * ratio);
    dust.height = Math.ceil((height + 48) * ratio);
    const stars = dust.getContext('2d');
    stars.scale(ratio, ratio);
    stars.fillStyle = '#bdcfea';
    // Cache 4,500 stars once per resize; each frame only shifts this bitmap.
    for (let i = 0; i < 4500; i++) {
      stars.globalAlpha = 0.16 + Math.random() * 0.5;
      const size = 0.45 + Math.random() * 0.95;
      stars.fillRect(Math.random() * (width + 48), Math.random() * (height + 48), size, size);
    }
    tooltip = null;
    if (wasHidden && bounds) fit();
  }

  function localPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: (clientX - rect.left) * width / (rect.width || 1), y: (clientY - rect.top) * height / (rect.height || 1) };
  }

  function pick(point) {
    const x = camera.x + (point.x - width / 2) / camera.scale;
    const y = camera.y + (point.y - height / 2) / camera.scale;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const item = nodes[i];
      const radius = Math.max(item.radius * (hovered === item ? 1.4 : 1), 5 / camera.scale);
      if ((x - item.x) ** 2 + (y - item.y) ** 2 <= radius ** 2) return item;
    }
    return null;
  }

  function hitTest(clientX, clientY) {
    if (!canvas || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return -1;
    const point = localPoint(clientX, clientY);
    if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return -1;
    const item = pick(point);
    return item ? item.data.index : -1;
  }

  // Camera x/y are world coordinates at the canvas centre; scale is CSS pixels per world unit.
  function setCamera(value) {
    if (!value) return;
    if (Number.isFinite(value.x)) camera.x = value.x;
    if (Number.isFinite(value.y)) camera.y = value.y;
    if (Number.isFinite(value.scale)) camera.scale = clamp(value.scale, 0.15, 4);
  }

  function zoomAt(scale, from, to) {
    const x = camera.x + (from.x - width / 2) / camera.scale;
    const y = camera.y + (from.y - height / 2) / camera.scale;
    camera.scale = clamp(scale, 0.15, 4);
    camera.x = x - (to.x - width / 2) / camera.scale;
    camera.y = y - (to.y - height / 2) / camera.scale;
  }

  function zoom(factor) {
    if (canvas && Number.isFinite(factor) && factor > 0) {
      const centre = { x: width / 2, y: height / 2 };
      zoomAt(camera.scale * factor, centre, centre);
    }
  }

  function fit() {
    if (!canvas) return;
    if (!bounds) { setCamera({ x: 0, y: 0, scale: 1 }); return; }
    setCamera({
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
      scale: Math.min(Math.max(1, width - 96) / Math.max(1, bounds.right - bounds.left), Math.max(1, height - 96) / Math.max(1, bounds.bottom - bounds.top))
    });
  }

  function wheel(event) {
    event.preventDefault();
    const point = localPoint(event.clientX, event.clientY);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    zoomAt(camera.scale * Math.exp(-event.deltaY * unit * 0.0015), point, point);
  }

  function pointerDown(event) {
    if (event.button !== 0) return;
    const point = localPoint(event.clientX, event.clientY);
    const item = pick(point);
    pointers.set(event.pointerId, { ...point, startX: point.x, startY: point.y, down: item ? item.data.index : -1, moved: false });
    canvas.setPointerCapture(event.pointerId);
    pointer = null;
    if (pointers.size > 1) for (const active of pointers.values()) active.moved = true;
  }

  function pointerMove(event) {
    const point = localPoint(event.clientX, event.clientY);
    const active = pointers.get(event.pointerId);
    if (!active) { pointer = event.pointerType === 'touch' ? null : point; return; }
    const pair = Array.from(pointers.values()).slice(0, 2);
    const oldDistance = pair.length === 2 ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
    const oldCentre = pair.length === 2 ? { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 } : null;
    const dx = point.x - active.x, dy = point.y - active.y;
    active.x = point.x;
    active.y = point.y;
    active.moved = active.moved || Math.hypot(point.x - active.startX, point.y - active.startY) > 4;
    if (pair.length === 2 && oldDistance > 0) {
      const centre = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
      zoomAt(camera.scale * Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) / oldDistance, oldCentre, centre);
    } else if (active.down === -1 && active.moved) {
      camera.x -= dx / camera.scale;
      camera.y -= dy / camera.scale;
    }
  }

  function pointerEnd(event) {
    const active = pointers.get(event.pointerId);
    if (!active) return;
    const point = localPoint(event.clientX, event.clientY);
    const item = pick(point);
    const clicked = event.type === 'pointerup' && !active.moved && Math.hypot(point.x - active.startX, point.y - active.startY) <= 4 && item && item.data.index === active.down;
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    pointer = event.pointerType === 'touch' ? null : point;
    if (pointers.size === 1) {
      const remaining = pointers.values().next().value;
      remaining.down = -1;
      remaining.moved = true;
    }
    if (clicked && typeof onPick === 'function') onPick(item.data);
  }

  function pointerLeave() { pointer = null; }

  function makeTooltip(item) {
    ctx.font = '13px system-ui, "Microsoft YaHei", sans-serif';
    const lines = [], limit = Math.max(16, Math.min(360, width - 40));
    for (const paragraph of String(item.data.text ?? '').split(/\r\n?|\n/)) {
      let line = '';
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > limit) { lines.push(line); line = ''; }
        line += char;
      }
      lines.push(line);
    }
    return { item, lines, width: Math.max(16, ...lines.map(line => ctx.measureText(line).width)) + 24, height: lines.length * 19 + 20 };
  }

  function drawTooltip() {
    if (!tooltip || !pointer) return;
    const scale = Math.min(1, Math.max(1, width - 16) / tooltip.width, Math.max(1, height - 16) / tooltip.height);
    const w = tooltip.width * scale, h = tooltip.height * scale;
    let x = pointer.x + 18, y = pointer.y + 18;
    if (x + w > width - 8) x = pointer.x - w - 18;
    if (y + h > height - 8) y = pointer.y - h - 18;
    ctx.save();
    ctx.translate(clamp(x, 8, Math.max(8, width - w - 8)), clamp(y, 8, Math.max(8, height - h - 8)));
    ctx.scale(scale, scale);
    ctx.globalAlpha = 0.98;
    ctx.fillStyle = '#101b2e';
    ctx.strokeStyle = tooltip.item.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0, 0, tooltip.width, tooltip.height, 8);
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = '13px system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#e5edf8';
    tooltip.lines.forEach((line, i) => ctx.fillText(line, 12, 10 + i * 19));
    ctx.restore();
  }

  function draw(now) {
    if (!canvas) return;
    if (pixelRatio !== (window.devicePixelRatio || 1)) resize();
    advance(now);
    hovered = pointer && !pointers.size ? pick(pointer) : null;
    if (hovered && (!tooltip || tooltip.item !== hovered)) tooltip = makeTooltip(hovered);
    if (!hovered) tooltip = null;
    canvas.style.cursor = pointers.size ? 'grabbing' : hovered ? 'pointer' : 'grab';
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    const phase = now * TAU / 30000;
    ctx.drawImage(dust, -24 + Math.sin(phase) * 9, -24 + Math.cos(phase) * 6, width + 48, height + 48);
    const s = camera.scale;
    ctx.setTransform(pixelRatio * s, 0, 0, pixelRatio * s, pixelRatio * (width / 2 - camera.x * s), pixelRatio * (height / 2 - camera.y * s));
    ctx.lineWidth = 1 / s;
    for (const edge of edges) {
      ctx.globalAlpha = 0.45 * Math.min(edge.from.alpha, edge.to.alpha);
      ctx.strokeStyle = edge.kind === 'correction' ? '#7fb2ff' : '#8b9bb4';
      ctx.setLineDash(edge.kind === 'correction' ? [] : [6 / s, 5 / s]);
      ctx.beginPath();
      ctx.moveTo(edge.from.x, edge.from.y);
      ctx.lineTo(edge.to.x, edge.to.y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#ffd166';
    ctx.globalAlpha = 0.65;
    ctx.setLineDash([6 / s, 6 / s]);
    for (const group of groups) {
      if (!group.owner) continue;
      ctx.beginPath();
      ctx.arc(group.x, group.y, group.radius + 40, 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const item of nodes) {
      const r = item.radius * (hovered === item ? 1.4 : 1);
      ctx.fillStyle = item.color;
      for (const layer of [[3.2, 0.07], [2, 0.18], [1, 1]]) {
        ctx.globalAlpha = item.alpha * layer[1];
        ctx.beginPath();
        ctx.arc(item.x, item.y, r * layer[0], 0, TAU);
        ctx.fill();
      }
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.globalAlpha = 1;
    ctx.font = '600 14px system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const group of groups) {
      ctx.fillStyle = group.owner ? '#ffd166' : '#aebdd4';
      ctx.fillText(group.name, width / 2 + (group.x - camera.x) * s, height / 2 + (group.y - camera.y - group.radius - (group.owner ? 40 : 14)) * s - 16);
    }
    drawTooltip();
    frameId = requestAnimationFrame(draw);
  }

  function destroy() {
    if (!canvas) return;
    cancelAnimationFrame(frameId);
    if (observer) observer.disconnect();
    window.removeEventListener('resize', resize);
    for (const [name, handler] of listeners) canvas.removeEventListener(name, handler);
    for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    canvas.style.touchAction = saved.touchAction;
    canvas.style.cursor = saved.cursor;
    canvas.style.width = saved.width;
    canvas.style.height = saved.height;
    for (const name of ['width', 'height']) {
      if (saved[name + 'Attribute'] === null) canvas.removeAttribute(name);
      else canvas.setAttribute(name, saved[name + 'Attribute']);
    }
    pointers.clear();
    nodes = []; groups = []; edges = [];
    canvas = ctx = observer = dust = background = saved = pointer = hovered = tooltip = bounds = onPick = null;
    frameId = 0;
    width = height = 1;
  }

  const listeners = [
    ['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerEnd],
    ['pointercancel', pointerEnd], ['lostpointercapture', pointerEnd], ['pointerleave', pointerLeave], ['wheel', wheel]
  ];

  function mount(target, opts) {
    if (!target || typeof target.getContext !== 'function') throw new TypeError('MemoryGalaxy.mount expects a canvas');
    const context = target.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    opts = opts || {};
    if ((opts.nodes !== undefined && !Array.isArray(opts.nodes)) || (opts.edges !== undefined && !Array.isArray(opts.edges))) {
      throw new TypeError('MemoryGalaxy.mount expects node and edge arrays');
    }
    destroy();
    canvas = target;
    ctx = context;
    onPick = opts.onPick;
    saved = { touchAction: canvas.style.touchAction, cursor: canvas.style.cursor, width: canvas.style.width, height: canvas.style.height, widthAttribute: canvas.getAttribute('width'), heightAttribute: canvas.getAttribute('height') };
    canvas.style.touchAction = 'none';
    setCamera({ x: 0, y: 0, scale: 1 });
    resize();
    update(opts.nodes || [], opts.edges || []);
    fit();
    for (const [name, handler] of listeners) canvas.addEventListener(name, handler, { passive: name !== 'wheel' });
    window.addEventListener('resize', resize);
    observer = new ResizeObserver(resize);
    observer.observe(canvas);
    frameId = requestAnimationFrame(draw);
  }

  window.MemoryGalaxy = { mount, update, setCamera, zoom, fit, destroy, hitTest };
}());
