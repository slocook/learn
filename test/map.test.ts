import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { graphPage } from "../src/map/graph-page.ts";
import { canvasJson, mapLines, mermaidMap, progressLine, writeMapFiles } from "../src/map/render.ts";
import type { Topic } from "../src/types.ts";
import { graph, node, tmpDir } from "./helpers.ts";

const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const g = graph(node("trig/law-of-cosines", [], "placed"), node("ik/two-link", ["trig/law-of-cosines"], "learning"), node("ik/goal", ["ik/two-link"], "locked"));
const topic: Topic = {
	slug: "ik",
	title: "Inverse kinematics",
	goal: "Solve 2-link IK",
	goal_node: "ik/goal",
	nodes: ["trig/law-of-cosines", "ik/two-link", "ik/goal"],
	status: "active",
	created: "",
	backlog: [{ text: "What about redundancy?", at: "" }],
};

test("progress line counts placed nodes as done", () => {
	assert.equal(progressLine(topic, g), "1/3 nodes · ≈2 lessons left");
});

test("map lines layer nodes, mark the goal and current node, and list parked tangents", () => {
	const text = mapLines(topic, g, plain).join("\n");
	assert.match(text, /depth 0[\s\S]*law-of-cosines \(already known\)/);
	assert.match(text, /◐ ik\/two-link \(current\)/);
	assert.match(text, /ik\/goal ★ goal/);
	assert.match(text, /needs: trig\/law-of-cosines/);
	assert.match(text, /What about redundancy\?/);
});

test("canvas is valid JSON Canvas with an edge per dependency", () => {
	const c = JSON.parse(canvasJson(topic, g));
	assert.equal(c.nodes.length, 3);
	assert.equal(c.edges.length, 2);
	assert.ok(c.nodes.every((n: { x: number; y: number }) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test("mermaid map has one class per state and safe ids", () => {
	const m = mermaidMap(topic, g);
	assert.match(m, /^graph TD/);
	assert.match(m, /ik_two_link\["◐ ik\/two-link"\]:::learning/);
	assert.match(m, /trig_law_of_cosines --> ik_two_link/);
});

test("map files are written for the topic", () => {
	const dir = tmpDir();
	writeMapFiles(dir, topic, g);
	assert.ok(fs.existsSync(path.join(dir, "ik.canvas")));
	assert.match(fs.readFileSync(path.join(dir, "ik.md"), "utf8"), /```mermaid/);
});

test("graph page embeds the svg and each node's prerequisites, escaped for HTML", () => {
	const page = graphPage({ ...topic, title: "IK </script> & more" }, g, '<svg id="my-svg"></svg>');
	assert.match(page, /<title>IK &lt;\/script&gt; &amp; more<\/title>/);
	assert.match(page, /<svg id="my-svg"><\/svg>/);
	const json = page.match(/const NODES = (.*);/)![1]!;
	const data = JSON.parse(json);
	assert.deepEqual(data.find((n: { id: string }) => n.id === "ik_two_link").requires, ["trig_law_of_cosines"]);
	assert.equal(data.find((n: { id: string }) => n.id === "ik_goal").goal, true);
});
