"use strict";

/* ---------- 状态 ---------- */
const canvas = document.getElementById("canvas");
const world = document.getElementById("world");
const itemsEl = document.getElementById("items");
const connLayer = document.getElementById("connLayer");
const gridEl = document.getElementById("grid");
const zoomValEl = document.getElementById("zoomVal");

const NS = "http://www.w3.org/2000/svg";
let scale = 1;          // 缩放
let panX = 0, panY = 0; // 平移（世界坐标系偏移）
let idSeed = 1;
let items = new Map();  // id -> DOM 元素（绝对定位在 #items 内）
let connections = [];   // { sid, tid, label }
let zTop = 10;

/* ---------- 世界变换 ---------- */
function applyTransform(x, y) {
  world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}
function screenToWorld(sx, sy) {
  const r = world.getBoundingClientRect();
  return { x: (sx - r.left) / scale, y: (sy - r.top) / scale };
}

/* ---------- 创建元素 ---------- */
function centerPos() {
  const r = canvas.getBoundingClientRect();
  const c = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  return { x: c.x, y: c.y };
}

function addText(x, y, text) {
  const el = document.createElement("div");
  el.className = "element node-text";
  el.dataset.id = ++idSeed;
  el.innerHTML = `<div class="dig" contenteditable="true" spellcheck="false">${esc(text || "双击输入文字")}</div>`;
  itemsEl.appendChild(el);
  setupElement(el, x, y);
  return el;
}

function addNote(x, y, text) {
  const el = document.createElement("div");
  el.className = "element node-note";
  el.dataset.id = ++idSeed;
  el.innerHTML = `<textarea class="dig" spellcheck="false" placeholder="输入便签内容…">${esc(text || "")}</textarea>`;
  itemsEl.appendChild(el);
  setupElement(el, x, y);
  return el;
}

function addImage(x, y, src) {
  const el = document.createElement("div");
  el.className = "element node-image";
  el.dataset.id = ++idSeed;
  el.innerHTML = `<img src="${src}" alt="图片" />`;
  itemsEl.appendChild(el);
  setupElement(el, x, y);
  return el;
}

function setupElement(el, x, y) {
  if (x == null) { const c = centerPos(); x = c.x; y = c.y; }
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.style.zIndex = zTop++;
  // 连接手柄
  const h = document.createElement("div");
  h.className = "connect-handle";
  h.title = "拖到目标元素上建立连线";
  el.appendChild(h);
  makeDraggable(el);
  select(el);
}

/* ---------- 箭头线元素 ---------- */
function addArrow(x, y, length, angle) {
  const el = document.createElement("div");
  el.className = "element node-arrow";
  el.dataset.id = ++idSeed;
  el.dataset.length = length || 180;
  el.dataset.angle = angle || 0;
  itemsEl.appendChild(el);
  el.style.left = (x == null ? 10 : x) + "px";
  el.style.top = (y == null ? 10 : y) + "px";
  el.style.zIndex = zTop++;
  el.innerHTML =
    `<div class="arrow-svg"></div>` +
    `<div class="ah-base" title="拖动调整方向"></div>` +
    `<div class="ah-tip" title="拖动调整长度"></div>`;
  updateArrow(el);
  attachArrow(el);
  select(el);
  return el;
}
function updateArrow(el) {
  const L = +el.dataset.length, a = +el.dataset.angle, hs = 16;
  el.style.width = L + "px";
  el.style.height = "20px";
  el.style.transformOrigin = "0 50%";
  el.style.transform = `rotate(${(a * 180 / Math.PI)}deg)`;
  el.querySelector(".arrow-svg").innerHTML =
    `<svg viewBox="0 0 ${L} 20" width="${L}" height="20" style="overflow:visible">` +
    `<line x1="0" y1="10" x2="${L - hs}" y2="10" stroke="#39c" stroke-width="2.5"/>` +
    `<polygon points="${L},10 ${L - hs},4 ${L - hs},16" fill="#39c"/></svg>`;
  el.querySelector(".ah-tip").style.left = (L - 5) + "px";
  el.querySelector(".ah-base").style.left = "-5px";
}
function attachArrow(el) {
  const base = el.querySelector(".ah-base"), tip = el.querySelector(".ah-tip");
  // 底座手柄：绕起点旋转调整指向
  const startRotate = (e) => {
    if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); select(el);
    const o = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
    const move = (ev) => { const w = screenToWorld(ev.clientX, ev.clientY); el.dataset.angle = Math.atan2(w.y - o.y, w.x - o.x); updateArrow(el); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  // 箭头手柄：调整长度（同时更新方向）
  const resizeArrow = (e) => {
    if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); select(el);
    const o = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
    const move = (ev) => { const w = screenToWorld(ev.clientX, ev.clientY); el.dataset.length = Math.max(40, Math.hypot(w.x - o.x, w.y - o.y)); el.dataset.angle = Math.atan2(w.y - o.y, w.x - o.x); updateArrow(el); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  base.addEventListener("mousedown", startRotate);
  tip.addEventListener("mousedown", resizeArrow);
  // 拖动箭头主体 = 移动起点
  el.addEventListener("mousedown", (e) => {
    if (e.target.closest(".ah-base") || e.target.closest(".ah-tip")) return;
    if (e.button !== 0) return; select(el); el.style.zIndex = zTop++;
    const sx = e.clientX, sy = e.clientY; const ox = parseFloat(el.style.left), oy = parseFloat(el.style.top);
    const move = (ev) => { el.style.left = ox + (ev.clientX - sx) / scale + "px"; el.style.top = oy + (ev.clientY - sy) / scale + "px"; };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
}

/* ---------- 拖拽移动元素 ---------- */
function makeDraggable(el) {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.classList.contains("connect-handle")) return;
    if (e.target.closest(".dig")) return; // 文本输入框内不拖动
    select(el);
    const startX = e.clientX, startY = e.clientY;
    const lx = parseFloat(el.style.left), ly = parseFloat(el.style.top);
    const source = { x: lx, y: ly };   // A 的原始位置（连线时锚点）
    el.style.zIndex = zTop++;
    // 拖动过程中的实时预览虚线（A -> 光标）
    const temp = document.createElementNS(NS, "path");
    temp.setAttribute("stroke", "#ff6a9b");
    temp.setAttribute("stroke-dasharray", "6 4");
    connLayer.appendChild(temp);
    const move = (ev) => {
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;
      el.style.left = lx + dx + "px";
      el.style.top = ly + dy + "px";
      renderConnections();          // 让已存在的关系线实时跟随
      const w = screenToWorld(ev.clientX, ev.clientY);
      const mx = (source.x + w.x) / 2, my = (source.y + w.y) / 2;
      temp.setAttribute("d", `M ${source.x} ${source.y} C ${mx} ${source.y}, ${mx} ${w.y}, ${w.x} ${w.y}`);
      connLayer.appendChild(temp);  // renderConnections 会清空连线层，需重新挂回预览线
    };
    const up = (ev) => {
      temp.remove();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      renderConnections();
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const toEl = under && under.closest ? under.closest(".element") : null;
      if (toEl && toEl !== el) {
        // 落在另一元素上：A 收回原位，生成可见关系线并追加备注
        el.style.left = source.x + "px";
        el.style.top = source.y + "px";
        const label = prompt("关系备注（可留空，之后点击线条上的标签可再修改）：", "");
        connections.push({ sid: el.dataset.id | 0, tid: toEl.dataset.id | 0, label: label || "" });
      }
      renderConnections();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

/* ---------- 连线 ---------- */
function handleCenter(el) {
  return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
}
function renderConnections() {
  connLayer.innerHTML = "";
  itemsEl.querySelectorAll(".conn-label").forEach(l => l.remove());
  connections.forEach((c) => {
    const sEl = items.get(c.sid), tEl = items.get(c.tid);
    if (!sEl || !tEl) return;
    const s = handleCenter(sEl), t = handleCenter(tEl);
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    const d = `M ${s.x} ${s.y} C ${mx} ${s.y}, ${mx} ${t.y}, ${t.x} ${t.y}`;
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d); p.setAttribute("stroke", "#6a7bff");
    connLayer.appendChild(p);
    // 箭头指向（A -> B）
    const ang = Math.atan2(t.y - s.y, t.x - s.x);
    const hs = 7, hl = Math.min(22, Math.hypot(t.x - s.x, t.y - s.y) / 2);
    const b1 = { x: t.x - hl * Math.cos(ang) - hs * Math.sin(ang), y: t.y - hl * Math.sin(ang) + hs * Math.cos(ang) };
    const b2 = { x: t.x - hl * Math.cos(ang) + hs * Math.sin(ang), y: t.y - hl * Math.sin(ang) - hs * Math.cos(ang) };
    const ah = document.createElementNS(NS, "polygon");
    ah.setAttribute("points", `${t.x},${t.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`);
    ah.setAttribute("fill", "#6a7bff");
    connLayer.appendChild(ah);
    const dot1 = document.createElementNS(NS, "circle");
    dot1.setAttribute("class", "dot");
    dot1.setAttribute("cx", s.x); dot1.setAttribute("cy", s.y); dot1.setAttribute("r", 4);
    connLayer.appendChild(dot1);
    // 可点击编辑的关系备注
    const lab = document.createElement("div");
    lab.className = "conn-label";
    lab.textContent = c.label || "(点击备注)";
    lab.style.left = mx + "px"; lab.style.top = my + "px";
    lab.addEventListener("mousedown", (e) => e.stopPropagation());
    lab.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = prompt("修改关系备注（留空删除）：", c.label || "");
      c.label = (v === null ? c.label : v.trim());
      renderConnections();
    });
    itemsEl.appendChild(lab);
  });
}

/* 手柄拖动建立连线 */
document.addEventListener("mousedown", (e) => {
  if (!e.target.classList.contains("connect-handle")) return;
  const fromEl = e.target.closest(".element");
  document.body.classList.add("connecting");
  const start = handleCenter(fromEl);
  // 临时跟踪线
  let tempPath = document.createElementNS(NS, "path");
  tempPath.setAttribute("stroke", "#ff6a9b");
  tempPath.setAttribute("stroke-dasharray", "6 4");
  connLayer.appendChild(tempPath);
  const move = (ev) => {
    const w = screenToWorld(ev.clientX, ev.clientY);
    const mx = (start.x + w.x) / 2, my = (start.y + w.y) / 2;
    tempPath.setAttribute("d", `M ${start.x} ${start.y} C ${mx} ${start.y}, ${mx} ${w.y}, ${w.x} ${w.y}`);
  };
  const up = (ev) => {
    document.body.classList.remove("connecting");
    tempPath.remove();
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    // 落到元素上
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const toEl = under && under.closest ? under.closest(".element") : null;
    if (toEl && toEl !== fromEl) {
      const label = prompt("连线文字（可留空）：","");
      connections.push({ sid: fromEl.dataset.id | 0, tid: toEl.dataset.id | 0, label: label || "" });
      renderConnections();
    }
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

/* ---------- 右键快捷菜单 ---------- */
let ctxPos = null, ctxTarget = null, autoImagePos = null;
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  ctxPos = screenToWorld(e.clientX, e.clientY);
  const under = document.elementFromPoint(e.clientX, e.clientY);
  ctxTarget = under && under.closest ? under.closest(".element") : null;
  const menu = document.getElementById("ctxMenu");
  document.querySelector('.ctx-item[data-act="del"]').style.display = ctxTarget ? "" : "none";
  menu.style.display = "block";
  menu.style.left = Math.min(e.clientX, innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = Math.min(e.clientY, innerHeight - menu.offsetHeight - 8) + "px";
});
document.addEventListener("click", () => document.getElementById("ctxMenu").style.display = "none");
document.addEventListener("wheel", () => document.getElementById("ctxMenu").style.display = "none");
document.getElementById("ctxMenu").addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item) return;
  const act = item.dataset.act;
  if (act === "text") addText(ctxPos.x, ctxPos.y);
  else if (act === "note") addNote(ctxPos.x, ctxPos.y);
  else if (act === "arrow") addArrow(ctxPos.x, ctxPos.y);
  else if (act === "image") { autoImagePos = { x: ctxPos.x, y: ctxPos.y }; document.getElementById("imageInput").click(); }
  else if (act === "del" && ctxTarget) {
    const id = ctxTarget.dataset.id | 0;
    items.delete(id); ctxTarget.remove();
    connections = connections.filter(c => c.sid !== id && c.tid !== id);
    renderConnections();
  }
  document.getElementById("ctxMenu").style.display = "none";
});

/* ---------- 平移 & 缩放 ---------- */
let panning = null;
canvas.addEventListener("mousedown", (e) => {
  // 点击空白（非元素）时开始平移
  if (e.target === canvas || e.target === gridEl || e.target === world) {
    panning = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    canvas.classList.add("panning");
  }
});
window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  panX = panning.px + (e.clientX - panning.x);
  panY = panning.py + (e.clientY - panning.y);
  applyTransform(panX, panY);
  gridEl.style.backgroundPosition = `${panX % 24}px ${panY % 24}px`;
});
window.addEventListener("mouseup", () => {
  panning = null;
  canvas.classList.remove("panning");
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  setScale(scale * factor, e.clientX, e.clientY);
}, { passive: false });

function setScale(ns, cx, cy) {
  ns = Math.min(3, Math.max(0.25, ns));
  if (ns === scale) return;
  const w = screenToWorld(cx, cy);
  scale = ns;
  // 以光标为中心缩放
  panX = cx - w.x * scale;
  panY = cy - w.y * scale;
  applyTransform(panX, panY);
  gridEl.style.backgroundSize = `${24 * scale}px ${24 * scale}px`;
  gridEl.style.backgroundPosition = `${panX % (24 * scale)}px ${panY % (24 * scale)}px`;
  zoomValEl.textContent = Math.round(scale * 100) + "%";
}

/* ---------- 双击空白添加文本 · 删除 ---------- */
canvas.addEventListener("dblclick", (e) => {
  if (e.target !== canvas && e.target !== gridEl && e.target !== world) return;
  const w = screenToWorld(e.clientX, e.clientY);
  addText(w.x, w.y);
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && e.target === document.body) {
    const sel = document.querySelector(".element.selected");
    if (sel) { items.delete(sel.dataset.id | 0); sel.remove(); connections = connections.filter(c => c.sid !== (sel.dataset.id|0) && c.tid !== (sel.dataset.id|0)); renderConnections(); }
    e.preventDefault();
  }
});

/* ---------- 选中 ---------- */
function select(el) {
  document.querySelectorAll(".element.selected").forEach(x => x.classList.remove("selected"));
  el.classList.add("selected");
}

/* ---------- 工具栏 ---------- */
document.getElementById("addTextBtn2").onclick = () => addText();
document.getElementById("addNoteBtn").onclick = () => addNote();
document.getElementById("addArrowBtn").onclick = () => addArrow();
document.getElementById("imageInput").addEventListener("change", (e) => {
  [...e.target.files].forEach(f => {
    const reader = new FileReader();
    reader.onload = () => addImage(autoImagePos ? autoImagePos.x : null, autoImagePos ? autoImagePos.y : null, reader.result);
    reader.readAsDataURL(f);
    autoImagePos = null;
  });
  e.target.value = "";
});
document.getElementById("clearConnBtn").onclick = () => { connections = []; renderConnections(); };
document.getElementById("clearBtn").onclick = () => { items.forEach(el => el.remove()); items.clear(); connections = []; renderConnections(); };
document.getElementById("saveBtn").onclick = save;
document.getElementById("importInput").addEventListener("change", load);
document.getElementById("zoomIn").onclick = () => setScale(scale * 1.1, innerWidth / 2, innerHeight / 2);
document.getElementById("zoomOut").onclick = () => setScale(scale * 0.9, innerWidth / 2, innerHeight / 2);

/* ---------- 保存 / 载入 ---------- */
function collect() {
  const data = { scale, panX, panY, nodes: [], connections, grid: 24 };
  items.forEach((el) => {
    data.nodes.push({
      id: el.dataset.id | 0,
      type: el.classList.contains("node-text") ? "text"
            : el.classList.contains("node-note") ? "note"
            : el.classList.contains("node-arrow") ? "arrow" : "image",
      x: parseFloat(el.style.left), y: parseFloat(el.style.top),
      content: el.querySelector(".dig") ? el.querySelector(".dig").innerText : "",
      src: el.querySelector("img") ? el.querySelector("img").getAttribute("src") : "",
      length: el.dataset.length ? +el.dataset.length : undefined,
      angle: el.dataset.angle ? +el.dataset.angle : undefined,
    });
  });
  return data;
}
function save() {
  const blob = new Blob([JSON.stringify(collect(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "wubianji.json";
  a.click();
}

/* 从 JSON 文件导入并重建画布 */
function load() {
  const f = document.getElementById("importInput").files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch (err) { alert("导入失败：文件格式不正确"); return; }
    // 清空现有内容
    items.forEach(el => el.remove());
    items.clear();
    connections = [];
    // 重建节点
    (data.nodes || []).forEach(n => {
      let el;
      if (n.type === "note") el = addNote(n.x, n.y, n.content);
      else if (n.type === "image") el = addImage(n.x, n.y, n.src);
      else if (n.type === "arrow") el = addArrow(n.x, n.y, n.length, n.angle);
      else el = addText(n.x, n.y, n.content);
      el.dataset.id = n.id; // 保留原 id，确保连线对得上
      idSeed = Math.max(idSeed, n.id || 0);
    });
    // 重建连线
    connections = (data.connections || []).filter(c => c.sid && c.tid && c.sid !== c.tid);
    renderConnections();
    // 恢复视图（缩放 & 平移）
    panX = data.panX || 0; panY = data.panY || 0; scale = data.scale || 1;
    applyTransform(panX, panY);
    const gs = 24 * scale;
    gridEl.style.backgroundSize = gs + "px " + gs + "px";
    gridEl.style.backgroundPosition = (panX % gs) + "px " + (panY % gs) + "px";
    zoomValEl.textContent = Math.round(scale * 100) + "%";
  };
  reader.readAsText(f);
  document.getElementById("importInput").value = "";
}
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s") { e.preventDefault(); save(); }
});

/* ---------- 辅助 ---------- */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* 初始化 */
applyTransform(panX, panY);
gridEl.style.backgroundSize = `24px 24px`;
addText(0, 0, "欢迎使用无边记 ✨");
addNote();
setScale(1, innerWidth / 2, innerHeight / 2);