import * as fs from "node:fs";
import * as path from "node:path";
import { depths, topicProgress } from "../graph/graph.ts";
import type { KNode, NodeState, Topic } from "../types.ts";
import type { ThemeLike } from "../ui/text.ts";

export const STATE_ICON: Record<NodeState, string> = {
	passed: "✓",
	"passed-assisted": "✓",
	"passed-override": "✓",
	weak: "~",
	placed: "●",
	learning: "◐",
	ready: "○",
	locked: "·",
};

const STATE_COLOR: Record<NodeState, string> = {
	passed: "success",
	"passed-assisted": "warning",
	"passed-override": "warning",
	weak: "warning",
	placed: "dim",
	learning: "accent",
	ready: "text",
	locked: "dim",
};

export const STATE_NOTE: Partial<Record<NodeState, string>> = {
	"passed-assisted": "passed with help",
	"passed-override": "passed by override",
	weak: "weak",
	placed: "already known",
	learning: "current",
};

export function topicNodes(topic: Topic, nodes: Map<string, KNode>): Map<string, KNode> {
	return new Map(topic.nodes.filter((id) => nodes.has(id)).map((id) => [id, nodes.get(id)!]));
}

export function progressLine(topic: Topic, nodes: Map<string, KNode>): string {
	const p = topicProgress(topic, nodes);
	const left = p.remaining === 0 ? "complete" : `≈${p.remaining} lesson${p.remaining === 1 ? "" : "s"} left`;
	return `${p.done}/${p.total} nodes · ${left}`;
}

/** The topic's graph layered by depth, for the terminal. */
export function mapLines(topic: Topic, nodes: Map<string, KNode>, theme: ThemeLike): string[] {
	const sub = topicNodes(topic, nodes);
	const depth = depths(sub);
	const layers = new Map<number, KNode[]>();
	for (const id of topic.nodes) {
		const n = sub.get(id);
		if (!n) continue;
		const d = depth.get(id) ?? 0;
		layers.set(d, [...(layers.get(d) ?? []), n]);
	}
	const out: string[] = [];
	out.push(theme.bold(`${topic.title}`) + theme.fg("muted", `  ${progressLine(topic, nodes)}`));
	out.push(theme.fg("muted", `Goal: ${topic.goal}`));
	out.push("");
	for (const d of [...layers.keys()].sort((a, b) => a - b)) {
		out.push(theme.fg("dim", `── depth ${d} ${"─".repeat(30)}`));
		for (const n of layers.get(d)!) {
			const icon = theme.fg(STATE_COLOR[n.state], STATE_ICON[n.state]);
			const goal = n.id === topic.goal_node ? theme.fg("accent", " ★ goal") : "";
			const note = STATE_NOTE[n.state] ? theme.fg(STATE_COLOR[n.state], ` (${STATE_NOTE[n.state]})`) : "";
			const lab = n.lab ? theme.fg("muted", ` [${n.lab.type} lab]`) : "";
			out.push(`  ${icon} ${theme.fg(n.state === "locked" || n.state === "placed" ? "dim" : "text", n.title)}${note}${lab}${goal}`);
			const needs = n.requires.filter((r) => sub.has(r)).map((r) => sub.get(r)!.title);
			if (needs.length > 0) out.push(theme.fg("dim", `      needs: ${needs.join(" · ")}`));
		}
	}
	out.push("");
	out.push(
		theme.fg("dim", "✓ passed  ◐ current  ○ ready  · locked  ● already known  ~ weak"),
	);
	if (topic.backlog.length > 0) {
		out.push("");
		out.push(theme.bold("Parked tangents"));
		for (const b of topic.backlog) out.push(theme.fg("muted", `  • ${b.text}`));
	}
	return out;
}

const CANVAS_COLOR: Partial<Record<NodeState, string>> = {
	passed: "4",
	"passed-assisted": "3",
	"passed-override": "3",
	weak: "2",
	learning: "6",
	ready: "5",
};

/** An Obsidian canvas (JSON Canvas 1.0) of the topic, laid out by depth. */
export function canvasJson(topic: Topic, nodes: Map<string, KNode>): string {
	const sub = topicNodes(topic, nodes);
	const depth = depths(sub);
	const rowAt = new Map<number, number>();
	const canvasNodes = topic.nodes
		.filter((id) => sub.has(id))
		.map((id) => {
			const n = sub.get(id)!;
			const d = depth.get(id) ?? 0;
			const row = rowAt.get(d) ?? 0;
			rowAt.set(d, row + 1);
			const label = STATE_NOTE[n.state] ? `\n*${STATE_NOTE[n.state]}*` : "";
			return {
				id: n.id,
				type: "text",
				text: `${STATE_ICON[n.state]} [[${n.id}|${n.title}]]${label}`,
				x: d * 420,
				y: row * 160,
				width: 360,
				height: 110,
				...(CANVAS_COLOR[n.state] ? { color: CANVAS_COLOR[n.state] } : {}),
			};
		});
	const edges = [...sub.values()].flatMap((n) =>
		n.requires.filter((r) => sub.has(r)).map((r) => ({ id: `${r}->${n.id}`, fromNode: r, fromSide: "right", toNode: n.id, toSide: "left" })),
	);
	return JSON.stringify({ nodes: canvasNodes, edges }, null, "\t");
}

export function mermaidId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function mermaidMap(topic: Topic, nodes: Map<string, KNode>): string {
	const sub = topicNodes(topic, nodes);
	const lines = ["graph TD"];
	for (const id of topic.nodes) {
		const n = sub.get(id);
		if (!n) continue;
		lines.push(`  ${mermaidId(n.id)}["${STATE_ICON[n.state]} ${n.title.replace(/"/g, "'")}"]:::${n.state.replace(/-/g, "_")}`);
	}
	for (const n of sub.values()) for (const r of n.requires) if (sub.has(r)) lines.push(`  ${mermaidId(r)} --> ${mermaidId(n.id)}`);
	lines.push(
		"  classDef passed fill:#d9f2d9,stroke:#3c873c",
		"  classDef passed_assisted fill:#fff3cd,stroke:#b08900",
		"  classDef passed_override fill:#fff3cd,stroke:#b08900",
		"  classDef weak fill:#ffe0cc,stroke:#c05600",
		"  classDef placed fill:#eeeeee,stroke:#999999,color:#666666",
		"  classDef learning fill:#e3d9f7,stroke:#6a3fc1",
		"  classDef ready fill:#d9ecf7,stroke:#2b7bb9",
		"  classDef locked fill:#ffffff,stroke:#bbbbbb,color:#888888",
	);
	return lines.join("\n");
}

/** Write maps/<topic>.canvas and maps/<topic>.md. */
export function writeMapFiles(mapsDir: string, topic: Topic, nodes: Map<string, KNode>): void {
	fs.mkdirSync(mapsDir, { recursive: true });
	fs.writeFileSync(path.join(mapsDir, `${topic.slug}.canvas`), canvasJson(topic, nodes), "utf8");
	const md = [
		`# ${topic.title}`,
		"",
		`**Goal:** ${topic.goal}`,
		"",
		`**Progress:** ${progressLine(topic, nodes)}`,
		"",
		"```mermaid",
		mermaidMap(topic, nodes),
		"```",
		"",
		...(topic.backlog.length > 0 ? ["## Parked tangents", "", ...topic.backlog.map((b) => `- ${b.text}`), ""] : []),
	].join("\n");
	fs.writeFileSync(path.join(mapsDir, `${topic.slug}.md`), md, "utf8");
}
