import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KNode, Topic } from "../types.ts";
import { renderMermaid } from "../viz/render.ts";
import { mermaidId, mermaidMap, progressLine, STATE_ICON, STATE_NOTE, topicNodes } from "./render.ts";

interface PageNode {
	id: string;
	title: string;
	state: string;
	requires: string[];
	goal: boolean;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * A self-contained page around the rendered dependency graph: pan and zoom, and hovering or
 * clicking a node highlights everything it builds on and everything it unlocks.
 */
export function graphPage(topic: Topic, nodes: Map<string, KNode>, svg: string): string {
	const sub = topicNodes(topic, nodes);
	const data: PageNode[] = topic.nodes
		.filter((id) => sub.has(id))
		.map((id) => {
			const n = sub.get(id)!;
			return {
				id: mermaidId(n.id),
				title: n.title,
				state: `${STATE_ICON[n.state]} ${STATE_NOTE[n.state] ?? n.state}`,
				requires: n.requires.filter((r) => sub.has(r)).map(mermaidId),
				goal: n.id === topic.goal_node,
			};
		});
	// JSON inside <script>: keep "</script>" in a title from closing the tag.
	const json = JSON.stringify(data).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(topic.title)}</title>
<style>
	:root { --bg: #fafafa; --fg: #222; --muted: #666; --panel: #fff; --border: #ddd; --up: #2b7bb9; --down: #c05600; }
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; }
	header { padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
	header h1 { font-size: 16px; margin: 0 0 2px; }
	header .muted { color: var(--muted); font-size: 13px; }
	.legend span { margin-right: 14px; white-space: nowrap; }
	.legend .up { color: var(--up); font-weight: 600; }
	.legend .down { color: var(--down); font-weight: 600; }
	main { flex: 1; display: flex; min-height: 0; }
	#view { flex: 1; overflow: hidden; cursor: grab; }
	#view.dragging { cursor: grabbing; }
	#view svg { width: 100%; height: 100%; max-width: none !important; }
	aside { width: 300px; padding: 12px 16px; border-left: 1px solid var(--border); background: var(--panel); overflow-y: auto; }
	aside h2 { font-size: 15px; margin: 0 0 4px; }
	aside h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 4px; color: var(--muted); }
	aside ul { margin: 0; padding-left: 18px; }
	aside li { cursor: pointer; }
	aside li:hover { text-decoration: underline; }
	.node, .flowchart-link { transition: opacity .12s; }
	svg.focus .node, svg.focus .flowchart-link { opacity: .15; }
	svg.focus .node.hl, svg.focus .flowchart-link.hl { opacity: 1; }
	svg.focus .node.sel rect { stroke: #000 !important; stroke-width: 3px !important; }
	svg.focus .node.up rect { stroke: var(--up) !important; stroke-width: 2.5px !important; }
	svg.focus .node.down rect { stroke: var(--down) !important; stroke-width: 2.5px !important; }
	svg.focus .flowchart-link.up { stroke: var(--up) !important; stroke-width: 2.5px !important; }
	svg.focus .flowchart-link.down { stroke: var(--down) !important; stroke-width: 2.5px !important; }
	@media (max-width: 700px) { main { flex-direction: column; } aside { width: auto; height: 35vh; border-left: 0; border-top: 1px solid var(--border); } }
</style>
</head>
<body>
<header>
	<h1>${escapeHtml(topic.title)}</h1>
	<div class="muted">${escapeHtml(progressLine(topic, nodes))}</div>
	<div class="muted legend">
		<span>✓ passed</span><span>◐ current</span><span>○ ready</span><span>· locked</span><span>● already known</span><span>~ weak</span>
		<span class="up">builds on</span><span class="down">unlocks</span>
		<span>Scroll to zoom, drag to pan, click a node to pin it, Esc to clear.</span>
	</div>
</header>
<main>
	<div id="view">${svg}</div>
	<aside id="info"><p class="muted">Hover or click a node to see what it builds on and what it unlocks.</p></aside>
</main>
<script>
const NODES = ${json};
const byId = new Map(NODES.map((n) => [n.id, n]));
const dependents = new Map(NODES.map((n) => [n.id, []]));
for (const n of NODES) for (const r of n.requires) dependents.get(r).push(n.id);
const svg = document.querySelector("#view svg");
const prefix = svg.id + "-";
const nodeEl = (id) => svg.querySelector('[id^="' + prefix + "flowchart-" + id + '-"]');
const edgeEl = (from, to) => svg.querySelector('[id="' + prefix + "L_" + from + "_" + to + '_0"]');

function walk(start, next) {
	const seen = new Set();
	const stack = [...next(start)];
	while (stack.length) {
		const id = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		stack.push(...next(id));
	}
	return seen;
}

let pinned = null;
function clear() {
	svg.classList.remove("focus");
	for (const el of svg.querySelectorAll(".hl, .up, .down, .sel")) el.classList.remove("hl", "up", "down", "sel");
}
function mark(el, ...cls) { if (el) el.classList.add("hl", ...cls); }
function show(id) {
	clear();
	const up = walk(id, (x) => byId.get(x).requires);
	const down = walk(id, (x) => dependents.get(x));
	svg.classList.add("focus");
	mark(nodeEl(id), "sel");
	for (const u of up) {
		mark(nodeEl(u), "up");
		for (const r of byId.get(u).requires) mark(edgeEl(r, u), "up");
	}
	for (const r of byId.get(id).requires) mark(edgeEl(r, id), "up");
	for (const d of down) {
		mark(nodeEl(d), "down");
		for (const r of byId.get(d).requires) if (r === id || down.has(r)) mark(edgeEl(r, d), "down");
	}
	info(id, up, down);
}
function list(title, ids) {
	if (!ids.length) return "";
	const items = ids.map((x) => '<li data-id="' + x + '">' + esc(byId.get(x).title) + "</li>").join("");
	return "<h3>" + title + "</h3><ul>" + items + "</ul>";
}
function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function info(id, up, down) {
	const n = byId.get(id);
	const order = NODES.map((x) => x.id);
	const sorted = (set) => order.filter((x) => set.has(x));
	document.getElementById("info").innerHTML =
		"<h2>" + esc(n.title) + (n.goal ? " ★" : "") + '</h2><div class="muted">' + esc(n.state) + "</div>" +
		list("Needs directly", n.requires) +
		list("Unlocks directly", dependents.get(id)) +
		list("Builds on (" + up.size + " in all)", sorted(up)) +
		list("Leads to (" + down.size + " in all)", sorted(down));
}
document.getElementById("info").addEventListener("click", (e) => {
	const id = e.target.closest("li")?.dataset.id;
	if (id) { pinned = id; show(id); }
});

const idFromEl = (el) => {
	const g = el.closest(".node");
	if (!g) return null;
	const m = g.id.slice((prefix + "flowchart-").length).match(/^(.*)-\\d+$/);
	return m && byId.has(m[1]) ? m[1] : null;
};
svg.addEventListener("mouseover", (e) => { const id = idFromEl(e.target); if (id && !pinned) show(id); });
svg.addEventListener("mouseout", (e) => { if (!pinned && idFromEl(e.target) && !idFromEl(e.relatedTarget ?? svg)) clear(); });
addEventListener("keydown", (e) => { if (e.key === "Escape") { pinned = null; clear(); } });

// Pan and zoom by editing the viewBox.
const base = svg.viewBox.baseVal;
let vb = { x: base.x, y: base.y, w: base.width, h: base.height };
const apply = () => svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
const scale = () => vb.w / svg.clientWidth;
svg.removeAttribute("style");
svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
svg.addEventListener("wheel", (e) => {
	e.preventDefault();
	const r = svg.getBoundingClientRect();
	const pt = svg.createSVGPoint();
	pt.x = e.clientX; pt.y = e.clientY;
	const p = pt.matrixTransform(svg.getScreenCTM().inverse());
	const k = Math.exp(e.deltaY * 0.0015);
	vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w: vb.w * k, h: vb.h * k };
	apply();
}, { passive: false });
let drag = null;
const view = document.getElementById("view");
svg.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; svg.setPointerCapture(e.pointerId); });
svg.addEventListener("pointermove", (e) => {
	if (!drag) return;
	const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
	if (!drag.moved && Math.hypot(dx, dy) < 4) return;
	drag.moved = true;
	view.classList.add("dragging");
	const s = Math.max(vb.w / svg.clientWidth, vb.h / svg.clientHeight);
	vb.x -= dx * s; vb.y -= dy * s;
	drag.x = e.clientX; drag.y = e.clientY;
	apply();
});
svg.addEventListener("pointerup", (e) => {
	const wasDrag = drag?.moved;
	drag = null;
	view.classList.remove("dragging");
	if (wasDrag) return;
	const id = idFromEl(document.elementFromPoint(e.clientX, e.clientY));
	if (id) { pinned = id; show(id); } else { pinned = null; clear(); }
});
</script>
</body>
</html>
`;
}

/** Render the topic's dependency graph and write maps/<topic>.html. Returns the page's path. */
export async function writeGraphPage(mapsDir: string, topic: Topic, nodes: Map<string, KNode>, browser?: string): Promise<string> {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-learn-graph-"));
	try {
		const svgFile = path.join(work, "graph.svg");
		await renderMermaid(mermaidMap(topic, nodes), svgFile, browser);
		const svg = fs.readFileSync(svgFile, "utf8").replace(/^<\?xml[^>]*>\s*/, "");
		fs.mkdirSync(mapsDir, { recursive: true });
		const out = path.join(mapsDir, `${topic.slug}.html`);
		fs.writeFileSync(out, graphPage(topic, nodes, svg), "utf8");
		return out;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}
