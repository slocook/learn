import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { deepMerge, parseModelRef } from "../src/config.ts";
import { validateChecks, validatePlan } from "../src/graph/validate.ts";
import { LadderProbe, startRung, strandBudget } from "../src/placement/probe.ts";
import { KnowledgeStore } from "../src/store/store.ts";
import type { Check } from "../src/types.ts";
import { graph, node, tmpDir } from "./helpers.ts";

test("nodes round-trip and keep their notes when rewritten", () => {
	const store = new KnowledgeStore(tmpDir());
	const n = node("linalg/jacobian", ["linalg/linear-map"]);
	store.saveNode(n, new Map([["linalg/linear-map", "Linear maps"]]));
	store.appendNotes(n.id, "### Lesson\nThe Jacobian is the local linear map.");
	store.saveNode({ ...n, state: "passed" });
	const back = store.getNode(n.id)!;
	assert.equal(back.state, "passed");
	const text = fs.readFileSync(store.nodeFile(n.id), "utf8");
	assert.match(text, /The Jacobian is the local linear map/);
	assert.match(text, /\[\[linalg\/linear-map\|/);
	assert.equal(store.loadNodes().size, 1);
});

test("node ids must be lowercase slugs", () => {
	const store = new KnowledgeStore(tmpDir());
	assert.throws(() => store.saveNode(node("Bad Id")));
});

test("gates freeze once and detect tampering", () => {
	const store = new KnowledgeStore(tmpDir());
	const checks: Check[] = [{ id: "c1", type: "free", prompt: "Why?", covers: [0], rubric: [{ idea: "x", accept: [] }], model_answer: "x" }];
	const gate = store.freezeGate("a", checks);
	assert.ok(store.verifyGate(store.getGate("a")!));
	assert.throws(() => store.freezeGate("a", checks), /already frozen/);
	const tampered = { ...gate, checks: [{ ...checks[0]!, prompt: "Why, really?" }] as Check[] };
	assert.equal(store.verifyGate(tampered), false);
});

test("evidence appends and filters", () => {
	const store = new KnowledgeStore(tmpDir());
	store.appendEvidence({ kind: "beat", node: "a" });
	store.appendEvidence({ kind: "park", node: "b" });
	assert.equal(store.readEvidence((e) => e.node === "a").length, 1);
});

test("plan validation catches structural problems", () => {
	const a = node("a", [], "placed");
	const b = node("b", ["a"], "locked", 6);
	const c = node("c", ["missing"]);
	const gates = new Map<string, Check[]>([
		["b", [{ id: "x", type: "choice", prompt: "?", covers: [0], options: [{ value: "1", label: "One" }, { value: "2", label: "I don't know" }], answer: "3", explanation: "" }]],
	]);
	const { errors } = validatePlan({ nodes: [a, b, c], existing: new Map(), gates, taught: new Set(["b", "c"]), goal: "b" });
	const all = errors.join("\n");
	assert.match(all, /b: 6 beats/);
	assert.match(all, /built-in "I don't know"/);
	assert.match(all, /answer "3" is not an option/);
	assert.match(all, /not covered by any check/);
	assert.match(all, /requires unknown node "missing"/);
	assert.match(all, /c: no gate written/);
});

test("a correct option that stands out by length is rejected", () => {
	const n = node("x", [], "locked", 1);
	const check: Check = {
		id: "c1",
		type: "choice",
		prompt: "?",
		covers: [0],
		options: [
			{ value: "a", label: "Short wrong claim" },
			{ value: "b", label: "Another wrong claim" },
			{ value: "c", label: "The correct claim, carefully qualified with every caveat that makes it right" },
		],
		answer: "c",
		explanation: "",
	};
	assert.match(validateChecks(n, [check]).join("\n"), /gives it away/);
	assert.deepEqual(validateChecks(n, [{ ...check, answer: "a" }]), []);
});

test("plan validation passes a well-formed plan", () => {
	const a = node("a", [], "placed");
	const b = node("b", ["a"]);
	const gates = new Map<string, Check[]>([
		["b", [{ id: "x", type: "free", prompt: "?", covers: [0, 1], rubric: [{ idea: "y", accept: [] }], model_answer: "y" }]],
	]);
	const { errors } = validatePlan({ nodes: [a, b], existing: graph(), gates, taught: new Set(["b"]), goal: "b" });
	assert.deepEqual(errors, []);
});

test("ladder probe binary-searches the frontier within its budget", () => {
	// Learner knows rungs 0..2 of 5.
	const knows = (r: number) => r <= 2;
	const probe = new LadderProbe(5, startRung(5, "use")!, 3);
	for (let r = probe.next(); r !== undefined; r = probe.next()) probe.record(r, knows(r));
	assert.equal(probe.frontier(), 2);
	assert.ok(probe.questionsAsked() <= 3);
});

test("ladder probe jumps up on a correct answer and finds a strong learner", () => {
	const probe = new LadderProbe(6, startRung(6, "derive")!, 3);
	for (let r = probe.next(); r !== undefined; r = probe.next()) probe.record(r, true);
	assert.equal(probe.frontier(), 5);
});

test("ladder probe comes down for a learner who over-reported", () => {
	const probe = new LadderProbe(6, startRung(6, "derive")!, 3);
	for (let r = probe.next(); r !== undefined; r = probe.next()) probe.record(r, false);
	assert.ok(probe.frontier() < 1);
});

test("never-seen strands are skipped and budgets are split", () => {
	assert.equal(startRung(5, "never"), undefined);
	assert.equal(strandBudget(15, 5, 3), 3);
	assert.equal(strandBudget(4, 3, 3), 1);
});

test("config merges deeply and model refs keep slashes in ids", () => {
	const merged = deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] });
	assert.deepEqual(merged, { a: { b: 1, c: 3 }, d: [2] });
	assert.deepEqual(parseModelRef("openrouter/z-ai/glm-5"), { provider: "openrouter", id: "z-ai/glm-5" });
	assert.equal(parseModelRef("inherit"), undefined);
});
