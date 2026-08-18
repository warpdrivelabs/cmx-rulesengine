// src/model/types.ts
var NODE_LABEL = {
  input: "\u8F93\u5165",
  output: "\u8F93\u51FA",
  decisionTable: "\u51B3\u7B56\u8868",
  expression: "\u8868\u8FBE\u5F0F",
  decision: "\u5B50\u51B3\u7B56"
};
var NODE_TYPES = ["input", "output", "decisionTable", "expression", "decision"];

// src/layout/layout.ts
var DEFAULT_LAYOUT = { colW: 190, rowH: 84, nodeW: 140, nodeH: 48, pad: 24 };
var PREVIEW_LAYOUT = { colW: 170, rowH: 74, nodeW: 128, nodeH: 44, pad: 20 };
function buildAdjacency(nodes, edges) {
  const id2i = new Map(nodes.map((n, i) => [n.id, i]));
  const indeg = nodes.map(() => 0);
  const adj = nodes.map(() => []);
  for (const e of edges) {
    const s = id2i.get(e.source);
    const t = id2i.get(e.target);
    if (s == null || t == null) continue;
    adj[s].push(t);
    indeg[t] += 1;
  }
  return { id2i, adj, indeg };
}
function kahnCount(nodes, edges) {
  const { adj, indeg } = buildAdjacency(nodes, edges);
  const ind = indeg.slice();
  const q = [];
  for (let i = 0; i < nodes.length; i++) if (ind[i] === 0) q.push(i);
  let cnt = 0;
  while (q.length) {
    const u = q.shift();
    cnt++;
    for (const v of adj[u]) if (--ind[v] === 0) q.push(v);
  }
  return cnt;
}
function hasCycle(def) {
  return kahnCount(def.nodes, def.edges) !== def.nodes.length;
}
function wouldCycle(def, src, tgt) {
  const edges = [...def.edges, { source: src, target: tgt }];
  return kahnCount(def.nodes, edges) !== def.nodes.length;
}
function topoOrder(nodes, adj, indeg) {
  const ind = indeg.slice();
  const q = [];
  for (let i = 0; i < nodes.length; i++) if (ind[i] === 0) q.push(i);
  const order = [];
  while (q.length) {
    const u = q.shift();
    order.push(u);
    for (const v of adj[u]) if (--ind[v] === 0) q.push(v);
  }
  if (order.length < nodes.length) {
    const seen = new Set(order);
    for (let i = 0; i < nodes.length; i++) if (!seen.has(i)) order.push(i);
  }
  return order;
}
function layout(def, cfg = DEFAULT_LAYOUT, hints) {
  const { nodes, edges } = def;
  const pos = {};
  if (!nodes.length) return { pos, width: cfg.pad * 2 + cfg.colW, height: cfg.pad * 2 + cfg.rowH };
  const { adj, indeg } = buildAdjacency(nodes, edges);
  const order = topoOrder(nodes, adj, indeg);
  const depth = nodes.map(() => 0);
  for (const u of order) for (const v of adj[u]) depth[v] = Math.max(depth[v], depth[u] + 1);
  nodes.forEach((n, i) => {
    if (n.type === "input") depth[i] = 0;
  });
  let maxDepth = 0;
  for (const d of depth) if (d > maxDepth) maxDepth = d;
  nodes.forEach((n, i) => {
    if (n.type === "output") depth[i] = maxDepth;
  });
  const cols = {};
  nodes.forEach((n, i) => {
    (cols[depth[i]] = cols[depth[i]] || []).push(i);
  });
  const numCols = Object.keys(cols).length;
  let maxRows = 1;
  for (const [lvl, idxs] of Object.entries(cols)) {
    maxRows = Math.max(maxRows, idxs.length);
    idxs.forEach((ni, r) => {
      pos[nodes[ni].id] = {
        x: cfg.pad + Number(lvl) * cfg.colW,
        y: cfg.pad + r * cfg.rowH,
        w: cfg.nodeW,
        h: cfg.nodeH
      };
    });
  }
  let width = cfg.pad * 2 + Math.max(1, numCols) * cfg.colW;
  let height = cfg.pad * 2 + maxRows * cfg.rowH;
  if (hints) {
    for (const n of nodes) {
      const h = hints[n.id];
      const p = pos[n.id];
      if (h && p) {
        p.x = h.x;
        p.y = h.y;
        width = Math.max(width, h.x + cfg.nodeW + cfg.pad);
        height = Math.max(height, h.y + cfg.nodeH + cfg.pad);
      }
    }
  }
  return { pos, width, height };
}

// src/model/GraphModel.ts
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function seedTable() {
  return {
    hitPolicy: "U",
    inputs: [{ id: "i1", label: "\u8F93\u51651", expression: "input1" }],
    outputs: [{ id: "o1", name: "result", label: "\u7ED3\u679C" }],
    rules: [{ id: "r1", inputEntries: ["-"], outputEntries: ['""'] }]
  };
}
var GraphModel = class _GraphModel {
  def;
  constructor(def) {
    this.def = def ? clone(def) : _GraphModel.skeleton();
    this.def.nodes = this.def.nodes || [];
    this.def.edges = this.def.edges || [];
    this.def.kind = "graph";
  }
  /** 最小合法骨架：input → output。 */
  static skeleton(key, name) {
    const def = {
      version: 1,
      kind: "graph",
      nodes: [
        { id: "in", name: "\u8F93\u5165", type: "input" },
        { id: "out", name: "\u8F93\u51FA", type: "output" }
      ],
      edges: [{ source: "in", target: "out" }]
    };
    if (key != null) def.key = key;
    const nm = name ?? key;
    if (nm != null) def.name = nm;
    return def;
  }
  /** 取当前 def 的深拷贝（宿主保存用）。 */
  getDef() {
    return clone(this.def);
  }
  /** 整体替换 def。 */
  setDef(def) {
    this.def = clone(def);
    this.def.nodes = this.def.nodes || [];
    this.def.edges = this.def.edges || [];
    this.def.kind = "graph";
  }
  get nodes() {
    return this.def.nodes;
  }
  get edges() {
    return this.def.edges;
  }
  node(id) {
    return this.def.nodes.find((n) => n.id === id);
  }
  /** 生成唯一节点 id。 */
  uid(prefix) {
    const ids = new Set(this.def.nodes.map((n) => n.id));
    let i = 1;
    while (ids.has(prefix + i)) i++;
    return prefix + i;
  }
  /** 新增节点（按类型带默认骨架）。返回新节点 id。 */
  addNode(type) {
    const id = type === "input" ? this.uid("in") : type === "output" ? this.uid("out") : this.uid("n");
    const node = { id, name: NODE_LABEL[type], type };
    if (type === "decisionTable") node.table = seedTable();
    if (type === "expression") node.mappings = [{ key: "field1", expression: "input1" }];
    if (type === "decision") node.decisionKey = "";
    this.def.nodes.push(node);
    return id;
  }
  /** 删除节点 + 所有关联边 + 清理布局提示。 */
  delNode(id) {
    this.def.nodes = this.def.nodes.filter((n) => n.id !== id);
    this.def.edges = this.def.edges.filter((e) => e.source !== id && e.target !== id);
    if (this.def._layout) delete this.def._layout[id];
  }
  /** 尝试加边。返回 null 成功，否则返回拒绝原因。 */
  addEdge(src, tgt) {
    if (src === tgt) return "\u4E0D\u80FD\u8FDE\u5230\u81EA\u5DF1";
    if (this.def.edges.some((e) => e.source === src && e.target === tgt)) return "\u8BE5\u8FB9\u5DF2\u5B58\u5728";
    if (wouldCycle(this.def, src, tgt)) return "\u8FDE\u7EBF\u4F1A\u5F62\u6210\u73AF\uFF08\u51B3\u7B56\u56FE\u6C42\u503C\u987B\u65E0\u73AF\uFF09";
    this.def.edges.push({ source: src, target: tgt });
    return null;
  }
  /** 删除边（按索引）。 */
  delEdge(idx) {
    this.def.edges.splice(idx, 1);
  }
  /** 更新节点名称。 */
  setNodeName(id, name) {
    const n = this.node(id);
    if (n) n.name = name;
  }
  /** decision 节点：设引用 key。 */
  setDecisionKey(id, key) {
    const n = this.node(id);
    if (n) n.decisionKey = key;
  }
  /** expression 节点：映射操作。 */
  addMapping(id) {
    const n = this.node(id);
    if (n) {
      n.mappings = n.mappings || [];
      n.mappings.push({ key: "field" + (n.mappings.length + 1), expression: "" });
    }
  }
  delMapping(id, i) {
    const n = this.node(id);
    if (n && n.mappings) n.mappings.splice(i, 1);
  }
  setMapping(id, i, patch) {
    const n = this.node(id);
    if (n && n.mappings && n.mappings[i]) Object.assign(n.mappings[i], patch);
  }
  /** 设/取拖拽坐标提示。 */
  setLayoutHint(id, x, y) {
    this.def._layout = this.def._layout || {};
    this.def._layout[id] = { x, y };
  }
  layoutHints() {
    return this.def._layout;
  }
  clearLayoutHints() {
    delete this.def._layout;
  }
  /** 本地结构校验（镜像后端 ir.rs：非空/id 唯一/边端点存在/decisionTable 须合法表）。返回 null 或首个违规信息。 */
  validate() {
    const { nodes, edges } = this.def;
    if (!nodes.length) return "\u51B3\u7B56\u56FE\u81F3\u5C11\u9700\u4E00\u4E2A\u8282\u70B9";
    const ids = /* @__PURE__ */ new Set();
    for (const n of nodes) {
      if (ids.has(n.id)) return `\u8282\u70B9 id \u91CD\u590D\uFF1A${n.id}`;
      ids.add(n.id);
    }
    for (const e of edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) return `\u8FB9\u7AEF\u70B9\u4E0D\u5B58\u5728\uFF1A${e.source} \u2192 ${e.target}`;
    }
    for (const n of nodes) {
      if (n.type === "decisionTable") {
        const t = n.table;
        if (!t) return `\u51B3\u7B56\u8868\u8282\u70B9\u300C${n.name || n.id}\u300D\u7F3A\u8868`;
        if (!(t.outputs || []).length) return `\u51B3\u7B56\u8868\u8282\u70B9\u300C${n.name || n.id}\u300D\u81F3\u5C11\u9700\u4E00\u4E2A\u8F93\u51FA\u5217`;
        const ni = (t.inputs || []).length;
        const no = (t.outputs || []).length;
        const rules = t.rules || [];
        for (let i = 0; i < rules.length; i++) {
          if ((rules[i].inputEntries || []).length !== ni) return `\u8282\u70B9\u300C${n.name || n.id}\u300D\u89C4\u5219\u884C ${i} \u8F93\u5165\u9879\u6570\u4E0E\u5217\u6570\u4E0D\u7B26`;
          if ((rules[i].outputEntries || []).length !== no) return `\u8282\u70B9\u300C${n.name || n.id}\u300D\u89C4\u5219\u884C ${i} \u8F93\u51FA\u9879\u6570\u4E0E\u5217\u6570\u4E0D\u7B26`;
        }
      }
      if (n.type === "decision" && !n.decisionKey) return `\u5B50\u51B3\u7B56\u8282\u70B9\u300C${n.name || n.id}\u300D\u672A\u9009\u62E9\u5F15\u7528\u51B3\u7B56`;
    }
    return null;
  }
};

// src/render/svg.ts
var esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
function nodeSub(n) {
  if (n.type === "decision") return n.decisionKey || "\u672A\u9009";
  if (n.type === "decisionTable") return (n.table?.rules || []).length + " \u884C";
  if (n.type === "expression") return (n.mappings || []).length + " \u6620\u5C04";
  return NODE_LABEL[n.type];
}
function renderSvg(def, layout2, state) {
  const { pos, width, height } = layout2;
  const nodes = def.nodes || [];
  const edges = def.edges || [];
  const ro = !!state.readonly;
  const defs = `<defs><marker id="dg-arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="#6a6d70"/></marker></defs>`;
  const edgeSvg = edges.map((e, i) => {
    const a = pos[e.source];
    const b = pos[e.target];
    if (!a || !b) return "";
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    const sel = state.selectedEdge === i ? " sel" : "";
    const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`;
    const hit = `<path class="dg-edge-hit" data-edge="${i}" d="${d}"/>`;
    return `${hit}<path class="dg-edge${sel}" d="${d}" marker-end="url(#dg-arrow)"/>`;
  }).join("");
  const nodeSvg = nodes.map((n) => {
    const p = pos[n.id];
    if (!p) return "";
    const sel = state.selectedNodeId === n.id ? " sel" : "";
    const csrc = state.connectFrom === n.id ? " csrc" : "";
    const hook = ` data-node="${esc(n.id)}"`;
    const port = ro ? "" : `<circle class="dg-port" data-port="${esc(n.id)}" cx="${p.w}" cy="${p.h / 2}" r="5"/>`;
    const roCls = ro ? " ro" : "";
    return `<g class="dg-node t-${esc(n.type)}${sel}${csrc}${roCls}"${hook} transform="translate(${p.x},${p.y})"><rect class="dg-nrect" rx="8" width="${p.w}" height="${p.h}"/><text class="dg-nlabel" x="${p.w / 2}" y="19">${esc(n.name || n.id)}</text><text class="dg-ntype" x="${p.w / 2}" y="35">${esc(NODE_LABEL[n.type] || n.type)} \xB7 ${esc(nodeSub(n))}</text>` + port + `</g>`;
  }).join("");
  const w = Math.max(width, 200);
  const h = Math.max(height, 120);
  return `<svg class="dg-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${defs}${edgeSvg}${nodeSvg}</svg>`;
}
function graphCss() {
  return `
  :host{
    /* \u4EE4\u724C\u951A\u5B9A UI5 --sap*\uFF08\u968F\u95E8\u6237\u4E3B\u9898\u7FFB\u8F6C\uFF0C\u7A7F\u900F shadow DOM\uFF09\uFF1B\u72EC\u7ACB\u65E0 --sap* \u65F6\u8D70 hex \u515C\u5E95\uFF08\u4EAE\u8272\uFF09\u3002 */
    --dg-fg:var(--sapTextColor,#1c2530);
    --dg-faint:var(--sapContent_LabelColor,#8b97b3);
    --dg-bg:var(--sapGroup_ContentBackground,#fff);
    --dg-surface:var(--sapList_Background,#fbfcfd);
    --dg-border:color-mix(in srgb,var(--sapField_BorderColor,#c9ced4) 85%,transparent);
    --dg-accent:var(--sapHighlightColor,#0a6ed1);
    --dg-accent2:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 55%,#00d0c0);
    --dg-ok:var(--sapPositiveColor,#178a5a);
    --dg-warn:var(--sapCriticalColor,#c26a00);
    --dg-danger:var(--sapNegativeColor,#d1394a);
    display:block;height:100%;color-scheme:light dark;font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--dg-fg)}
  .dg-canvas{position:relative;width:100%;height:100%;overflow:auto;box-sizing:border-box;background:
    radial-gradient(130% 90% at 50% -12%,color-mix(in srgb,var(--dg-accent) 8%,transparent),transparent 62%),
    linear-gradient(90deg,color-mix(in srgb,var(--dg-accent) 7%,transparent) 1px,transparent 1px) 0 0/24px 24px,
    linear-gradient(color-mix(in srgb,var(--dg-accent) 7%,transparent) 1px,transparent 1px) 0 0/24px 24px,var(--dg-surface)}
  .dg-svg{display:block}
  .dg-node{cursor:grab}
  .dg-node.ro{cursor:pointer}
  .dg-node.dragging{cursor:grabbing}
  .dg-nrect{fill:var(--dg-bg);stroke:var(--dg-border);stroke-width:1.5;transition:stroke .12s,filter .12s}
  .dg-node:hover .dg-nrect{stroke:var(--dg-accent);filter:drop-shadow(0 2px 8px color-mix(in srgb,var(--dg-accent) 40%,transparent))}
  .dg-node.sel .dg-nrect{stroke:var(--dg-accent);stroke-width:2.5;filter:drop-shadow(0 2px 10px color-mix(in srgb,var(--dg-accent) 50%,transparent))}
  .dg-node.csrc .dg-nrect{stroke:var(--dg-warn);stroke-width:2.5;stroke-dasharray:4 2}
  .dg-node.t-input .dg-nrect,.dg-node.t-output .dg-nrect{fill:color-mix(in srgb,var(--dg-faint) 12%,var(--dg-bg))}
  .dg-node.t-decisionTable .dg-nrect{fill:color-mix(in srgb,var(--dg-accent) 12%,var(--dg-bg))}
  .dg-node.t-expression .dg-nrect{fill:color-mix(in srgb,var(--dg-ok) 13%,var(--dg-bg))}
  .dg-node.t-decision .dg-nrect{fill:color-mix(in srgb,#7c5cff 13%,var(--dg-bg))}
  .dg-nlabel{font-size:12px;font-weight:600;fill:var(--dg-fg);text-anchor:middle;pointer-events:none;user-select:none}
  .dg-ntype{font-size:9px;fill:var(--dg-faint);text-anchor:middle;pointer-events:none;user-select:none}
  .dg-edge{fill:none;stroke:color-mix(in srgb,var(--dg-accent) 50%,var(--dg-faint));stroke-width:1.5;pointer-events:none}
  .dg-edge.sel{stroke:var(--dg-danger);stroke-width:2.5}
  .dg-edge-hit{fill:none;stroke:transparent;stroke-width:12;cursor:pointer}
  .dg-edge-hit:hover + .dg-edge{stroke:var(--dg-accent);stroke-width:2.5}
  .dg-port{fill:var(--dg-bg);stroke:var(--dg-accent);stroke-width:1.5;opacity:0;cursor:crosshair;transition:opacity .1s}
  .dg-node:hover .dg-port{opacity:1}
  .dg-port:hover{fill:var(--dg-accent);r:6}
  .dg-rubber{fill:none;stroke:var(--dg-accent);stroke-width:1.5;stroke-dasharray:4 3;pointer-events:none}
  .dg-empty{padding:20px;color:var(--dg-faint);text-align:center}
  #dg-arrow path{fill:color-mix(in srgb,var(--dg-accent) 50%,var(--dg-faint))}
  `;
}

// src/interaction/pointer.ts
var DRAG_THRESHOLD = 5;
var InteractionController = class {
  model;
  cb;
  mode = "idle";
  activeId = null;
  startX = 0;
  startY = 0;
  grabDX = 0;
  grabDY = 0;
  moved = false;
  pointerId = -1;
  constructor(model, cb) {
    this.model = model;
    this.cb = cb;
  }
  /** 客户端坐标 → SVG 用户坐标（考虑滚动/缩放/viewBox）。 */
  toSvgPoint(clientX, clientY) {
    const svg = this.cb.getSvg();
    if (!svg) return { x: clientX, y: clientY };
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const sx = vb && vb.width ? vb.width / rect.width : 1;
    const sy = vb && vb.height ? vb.height / rect.height : 1;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  }
  /** pointerdown：落在节点体 → 准备拖拽；落在连接点 → 准备拉线。 */
  onPointerDown(ev) {
    const target = ev.target;
    const portEl = target.closest("[data-port]");
    const nodeEl = target.closest("[data-node]");
    if (portEl) {
      this.mode = "connect";
      this.activeId = portEl.getAttribute("data-port");
      this.pointerId = ev.pointerId;
      this.safeCapture(ev);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (nodeEl) {
      const id = nodeEl.getAttribute("data-node");
      if (!id) return;
      this.mode = "drag";
      this.activeId = id;
      this.moved = false;
      this.pointerId = ev.pointerId;
      const pt = this.toSvgPoint(ev.clientX, ev.clientY);
      this.startX = pt.x;
      this.startY = pt.y;
      const pos = this.cb.getLayout().pos[id];
      this.grabDX = pos ? pt.x - pos.x : 0;
      this.grabDY = pos ? pt.y - pos.y : 0;
      this.safeCapture(ev);
      ev.preventDefault();
    }
  }
  /** 捕获指针（真实指针成功；合成事件/无活跃指针会抛，吞掉不影响交互）。 */
  safeCapture(ev) {
    try {
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
    } catch {
    }
  }
  onPointerMove(ev) {
    if (this.mode === "idle" || ev.pointerId !== this.pointerId) return;
    const pt = this.toSvgPoint(ev.clientX, ev.clientY);
    if (this.mode === "drag" && this.activeId) {
      const dx = pt.x - this.startX;
      const dy = pt.y - this.startY;
      if (!this.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      this.moved = true;
      this.cb.onNodeDrag(this.activeId, Math.max(0, pt.x - this.grabDX), Math.max(0, pt.y - this.grabDY));
    } else if (this.mode === "connect" && this.activeId) {
      const pos = this.cb.getLayout().pos[this.activeId];
      const from = pos ? { x: pos.x + pos.w, y: pos.y + pos.h / 2 } : null;
      this.cb.onRubber(from, { x: pt.x, y: pt.y });
    }
  }
  onPointerUp(ev) {
    if (this.mode === "idle" || ev.pointerId !== this.pointerId) return;
    if (this.mode === "drag" && this.activeId) {
      const pt = this.toSvgPoint(ev.clientX, ev.clientY);
      const moved = Math.abs(pt.x - this.startX) + Math.abs(pt.y - this.startY) >= DRAG_THRESHOLD;
      if (moved && this.moved) this.cb.onNodeDragEnd(this.activeId);
      else this.cb.onNodeSelect(this.activeId);
    } else if (this.mode === "connect" && this.activeId) {
      const pt = this.toSvgPoint(ev.clientX, ev.clientY);
      const tgt = this.hitNode(pt.x, pt.y);
      this.cb.onRubber(null, null);
      if (tgt && tgt !== this.activeId) this.cb.onConnect(this.activeId, tgt);
    }
    this.reset(ev);
  }
  /** 用布局盒命中测试落点所在节点 id。 */
  hitNode(x, y) {
    const pos = this.cb.getLayout().pos;
    for (const n of this.model.nodes) {
      const p = pos[n.id];
      if (p && x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return n.id;
    }
    return null;
  }
  onPointerCancel(ev) {
    this.cb.onRubber(null, null);
    this.reset(ev);
  }
  reset(ev) {
    try {
      ev.currentTarget?.releasePointerCapture?.(this.pointerId);
    } catch {
    }
    this.mode = "idle";
    this.activeId = null;
    this.moved = false;
    this.pointerId = -1;
  }
};

// src/element/cmx-decision-graph.ts
var CmxDecisionGraph = class extends HTMLElement {
  static get observedAttributes() {
    return ["data-graph", "readonly"];
  }
  root;
  model = new GraphModel();
  decisions = [];
  selectedNodeId = null;
  selectedEdge = null;
  rubber = { from: null, to: null };
  interaction;
  _readonly = false;
  _bootstrapped = false;
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.interaction = new InteractionController(this.model, {
      getLayout: () => this.currentLayout(),
      getSvg: () => this.root.querySelector("svg"),
      onNodeDrag: (id, x, y) => {
        this.model.setLayoutHint(id, x, y);
        this.paint();
      },
      onNodeDragEnd: (id) => {
        this.emit("graph-change", { graph: this.model.getDef() });
        void id;
      },
      onNodeSelect: (id) => this.selectNode(id),
      onRubber: (from, to) => {
        this.rubber = { from, to };
        this.paint();
      },
      onConnect: (src, tgt) => this.tryConnect(src, tgt)
    });
  }
  connectedCallback() {
    if (this._readonly !== this.hasAttribute("readonly")) this._readonly = this.hasAttribute("readonly");
    if (!this._bootstrapped) {
      this._bootstrapped = true;
      const raw = this.getAttribute("data-graph");
      if (raw) {
        try {
          this.model.setDef(JSON.parse(raw));
        } catch {
        }
      }
    }
    this.render();
  }
  attributeChangedCallback(name, _old, value) {
    if (name === "readonly") {
      this._readonly = value != null;
      if (this.isConnected) this.render();
    } else if (name === "data-graph" && value != null && this._bootstrapped) {
      try {
        this.model.setDef(JSON.parse(value));
        this.render();
      } catch {
      }
    }
  }
  // ── 公共 API ──
  setGraph(def) {
    this.model.setDef(def);
    this.selectedNodeId = null;
    this.selectedEdge = null;
    if (this.isConnected) this.render();
  }
  getGraph() {
    return this.model.getDef();
  }
  getModel() {
    return this.model;
  }
  setDecisions(list) {
    this.decisions = list || [];
  }
  getDecisions() {
    return this.decisions;
  }
  validate() {
    return this.model.validate();
  }
  addNode(type) {
    const id = this.model.addNode(type);
    this.selectNode(id);
    this.emit("graph-change", { graph: this.model.getDef() });
    this.emit("node-add", { nodeId: id });
    return id;
  }
  delNode(id) {
    this.model.delNode(id);
    if (this.selectedNodeId === id) this.selectedNodeId = null;
    this.render();
    this.emit("graph-change", { graph: this.model.getDef() });
    this.emit("node-del", { nodeId: id });
  }
  delEdge(idx) {
    this.model.delEdge(idx);
    this.selectedEdge = null;
    this.render();
    this.emit("graph-change", { graph: this.model.getDef() });
    this.emit("edge-del", { index: idx });
  }
  /** 重排回自动布局（清拖拽提示）。 */
  autoLayout() {
    this.model.clearLayoutHints();
    this.render();
    this.emit("graph-change", { graph: this.model.getDef() });
  }
  selectNode(id) {
    this.selectedNodeId = id;
    this.selectedEdge = null;
    this.paint();
    const n = this.model.node(id);
    this.emit("node-select", { nodeId: id, node: n ? JSON.parse(JSON.stringify(n)) : null });
  }
  /** 供宿主编辑节点后回写模型并重画（宿主改的是 getModel() 的节点，调此刷新）。 */
  refresh() {
    this.render();
  }
  // ── 内部 ──
  cfg() {
    return this._readonly ? PREVIEW_LAYOUT : DEFAULT_LAYOUT;
  }
  currentLayout() {
    return layout(this.model.getDef(), this.cfg(), this.model.layoutHints());
  }
  tryConnect(src, tgt) {
    const err = this.model.addEdge(src, tgt);
    if (err) {
      this.emit("connect-rejected", { src, tgt, reason: err });
      this.paint();
      return;
    }
    this.render();
    this.emit("graph-change", { graph: this.model.getDef() });
    this.emit("edge-add", { source: src, target: tgt });
  }
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
  /** 全量渲染（含容器 + 事件绑定）。 */
  render() {
    const lay = this.currentLayout();
    const state = {
      selectedNodeId: this.selectedNodeId,
      selectedEdge: this.selectedEdge,
      connectFrom: null,
      readonly: this._readonly
    };
    const svg = this.model.nodes.length ? renderSvg(this.model.getDef(), lay, state) : '<div class="dg-empty">\u7A7A\u56FE</div>';
    this.root.innerHTML = `<style>${graphCss()}</style><div class="dg-canvas" part="canvas">${svg}</div>`;
    if (this._readonly) this.bindReadonlySelect();
    else this.bindInteractions();
  }
  /** 仅重画 SVG（拖拽/选中高频路径，不重建容器；监听器绑在持久的 .dg-canvas 上，paint 不影响）。 */
  paint() {
    const canvas = this.root.querySelector(".dg-canvas");
    if (!canvas) {
      this.render();
      return;
    }
    const lay = this.currentLayout();
    const state = {
      selectedNodeId: this.selectedNodeId,
      selectedEdge: this.selectedEdge,
      connectFrom: null,
      readonly: this._readonly
    };
    let svg = this.model.nodes.length ? renderSvg(this.model.getDef(), lay, state) : '<div class="dg-empty">\u7A7A\u56FE</div>';
    if (this.rubber.from && this.rubber.to) {
      const r = `<path class="dg-rubber" d="M${this.rubber.from.x},${this.rubber.from.y} L${this.rubber.to.x},${this.rubber.to.y}"/>`;
      svg = svg.replace("</svg>", r + "</svg>");
    }
    canvas.innerHTML = svg;
  }
  /** 事件委托绑在持久的 .dg-canvas 容器上（幂等），故 paint 重画 svg 不丢监听器。 */
  bindInteractions() {
    const canvas = this.root.querySelector(".dg-canvas");
    if (!canvas || canvas.__dgBound) return;
    canvas.__dgBound = true;
    canvas.addEventListener("pointerdown", (e) => this.interaction.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.interaction.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.interaction.onPointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.interaction.onPointerCancel(e));
    canvas.addEventListener("click", (e) => {
      const el = e.target.closest("[data-edge]");
      if (el) {
        this.selectedEdge = Number(el.getAttribute("data-edge"));
        this.selectedNodeId = null;
        this.paint();
        const edge = this.model.edges[this.selectedEdge];
        this.emit("edge-select", { index: this.selectedEdge, edge: edge ? { source: edge.source, target: edge.target } : null });
      }
    });
  }
  /** 只读态：仅绑「点选」（节点/边），不绑拖拽/连线。供列表页只读预览点节点看属性。 */
  bindReadonlySelect() {
    const canvas = this.root.querySelector(".dg-canvas");
    if (!canvas || canvas.__dgRoBound) return;
    canvas.__dgRoBound = true;
    canvas.addEventListener("click", (e) => {
      const edgeEl = e.target.closest("[data-edge]");
      if (edgeEl) {
        this.selectedEdge = Number(edgeEl.getAttribute("data-edge"));
        this.selectedNodeId = null;
        this.paint();
        const edge = this.model.edges[this.selectedEdge];
        this.emit("edge-select", { index: this.selectedEdge, edge: edge ? { source: edge.source, target: edge.target } : null });
        return;
      }
      const nodeEl = e.target.closest("[data-node]");
      if (nodeEl) {
        const id = nodeEl.getAttribute("data-node");
        if (id) this.selectNode(id);
      }
    });
  }
  // ── 静态：调色板类型元数据（宿主工具栏用） ──
  static get NODE_TYPES() {
    return NODE_TYPES;
  }
  static get NODE_LABEL() {
    return NODE_LABEL;
  }
};
function defineDecisionGraph() {
  if (typeof customElements !== "undefined" && !customElements.get("cmx-decision-graph")) {
    customElements.define("cmx-decision-graph", CmxDecisionGraph);
  }
}

// src/index.ts
var VERSION = "1.0.0";
defineDecisionGraph();
export {
  CmxDecisionGraph,
  DEFAULT_LAYOUT,
  GraphModel,
  NODE_LABEL,
  NODE_TYPES,
  PREVIEW_LAYOUT,
  VERSION,
  defineDecisionGraph,
  graphCss,
  hasCycle,
  layout,
  renderSvg,
  wouldCycle
};
