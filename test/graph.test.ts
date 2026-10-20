import assert from "node:assert/strict";
import { test } from "node:test";
import { closure, depths, findCycle, nextNode, recomputeStates, topicProgress, topoSort } from "../src/graph/graph.ts";
import { canTransition, transition } from "../src/graph/state.ts";
import { graph, node } from "./helpers.ts";

test("topoSort puts prerequisites first and keeps preferred order among ties", () => {
	const g = graph(node("c", ["a", "b"]), node("b"), node("a"));
	assert.deepEqual(topoSort(g, ["a", "b", "c"]), ["a", "b", "c"]);
	assert.deepEqual(topoSort(g, ["b", "a", "c"]), ["b", "a", "c"]);
});

test("findCycle reports the cycle and topoSort refuses it", () => {
	const g = graph(node("a", ["c"]), node("b", ["a"]), node("c", ["b"]));
	const cycle = findCycle(g);
	assert.ok(cycle);
	assert.equal(cycle[0], cycle.at(-1));
	assert.throws(() => topoSort(g), /cycle/);
});

test("depths layer nodes by their deepest prerequisite", () => {
	const g = graph(node("a"), node("b", ["a"]), node("c", ["a", "b"]), node("d"));
	const d = depths(g);
	assert.equal(d.get("a"), 0);
	assert.equal(d.get("b"), 1);
	assert.equal(d.get("c"), 2);
	assert.equal(d.get("d"), 0);
});

test("closure collects everything a goal transitively needs", () => {
	const g = graph(node("a"), node("b", ["a"]), node("c", ["b"]), node("x"));
	assert.deepEqual([...closure(g, "c")].sort(), ["a", "b", "c"]);
});

test("recomputeStates unlocks nodes whose prerequisites are satisfied", () => {
	const g = graph(node("a", [], "placed"), node("b", ["a"], "locked"), node("c", ["b"], "locked"));
	assert.deepEqual(recomputeStates(g), ["b"]);
	assert.equal(g.get("b")!.state, "ready");
	assert.equal(g.get("c")!.state, "locked");
});

test("recomputeStates relocks a learning node when a prerequisite is un-placed", () => {
	const g = graph(node("a", [], "ready"), node("b", ["a"], "learning"));
	recomputeStates(g);
	assert.equal(g.get("b")!.state, "locked");
});

test("weak and override count as satisfied for unlocking", () => {
	const g = graph(node("a", [], "weak"), node("b", [], "passed-override"), node("c", ["a", "b"]));
	recomputeStates(g);
	assert.equal(g.get("c")!.state, "ready");
});

test("nextNode prefers a node being learned, then the first ready node in topic order", () => {
	const g = graph(node("a", [], "ready"), node("b", [], "ready"));
	assert.equal(nextNode({ nodes: ["b", "a"] }, g)?.id, "b");
	g.get("a")!.state = "learning";
	assert.equal(nextNode({ nodes: ["b", "a"] }, g)?.id, "a");
});

test("topicProgress counts satisfied nodes and remaining beats", () => {
	const g = graph(node("a", [], "placed"), node("b", [], "passed"), node("c", [], "ready", 3), node("d", [], "locked", 4));
	const p = topicProgress({ nodes: ["a", "b", "c", "d"] }, g);
	assert.deepEqual(p, { total: 4, done: 2, remaining: 2, beatsLeft: 7, placed: 1, weak: 0 });
});

test("state transitions enforce the rules", () => {
	assert.equal(transition("ready", "start"), "learning");
	assert.equal(transition("ready", "pass"), "passed");
	assert.equal(transition("learning", "assist"), "passed-assisted");
	assert.equal(transition("placed", "unplace"), "ready");
	assert.equal(transition("locked", "override"), "passed-override");
	assert.throws(() => transition("locked", "start"));
	assert.throws(() => transition("passed", "pass"));
	assert.throws(() => transition("ready", "assist"));
	assert.equal(canTransition("passed", "override"), false);
});
