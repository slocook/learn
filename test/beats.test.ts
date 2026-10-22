import assert from "node:assert/strict";
import { test } from "node:test";
import { type BeatVerdict, beatWarnings, isBorderline, isFlagged } from "../src/learn/beat-check.ts";
import { remainingBeats } from "../src/learn/rewrite-beats.ts";
import type { Topic } from "../src/types.ts";
import { graph, node } from "./helpers.ts";

const verdict = (kind: BeatVerdict["kind"], idea: number, index = 0): BeatVerdict => ({ node: "ik/a", title: "A", index, point: `beat ${index}`, kind, idea });

test("anything but a plain idea is flagged; a weak idea is borderline", () => {
	assert.equal(isFlagged(verdict("exercise", 0.1)), true);
	assert.equal(isFlagged(verdict("idea", 0.4)), false);
	assert.equal(isBorderline(verdict("idea", 0.4)), true);
	assert.equal(isBorderline(verdict("idea", 0.9)), false);
	const w = beatWarnings([verdict("idea", 0.9, 0), verdict("result", 0.2, 1), verdict("idea", 0.5, 2)]);
	assert.equal(w.length, 2);
	assert.match(w[0]!, /ik\/a beat 2 .*closed form/);
	assert.match(w[1]!, /ik\/a beat 3 may not be/);
});

test("remaining beats skip known and passed nodes and the current lesson's finished beats", () => {
	const g = graph(node("t/known", [], "placed"), node("t/done", [], "passed"), node("t/now", ["t/done"], "learning", 3), node("t/next", ["t/now"], "locked", 2));
	const topic = { slug: "t", nodes: ["t/known", "t/done", "t/now", "t/next"], lesson: { node: "t/now", beats_done: [0] } } as unknown as Topic;
	assert.deepEqual(
		remainingBeats(topic, g).map((b) => `${b.node}#${b.index}`),
		["t/now#1", "t/now#2", "t/next#0", "t/next#1"],
	);
});
