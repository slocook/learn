import assert from "node:assert/strict";
import { test } from "node:test";
import { combineFreeVerdict, gradeChoice, gradeNumeric, statusFromProbability } from "../src/gate/grade.ts";
import { evaluate } from "../src/gate/numeric.ts";
import type { ChoiceCheck, FreeCheck, NumericCheck } from "../src/types.ts";

const choice: ChoiceCheck = {
	id: "c1",
	type: "choice",
	prompt: "?",
	covers: [0],
	options: [
		{ value: "a", label: "A" },
		{ value: "b", label: "B" },
		{ value: "c", label: "C" },
	],
	answer: ["a", "c"],
	explanation: "",
};

test("choice grading is an exact-set match", () => {
	assert.equal(gradeChoice(choice, ["c", "a"]), true);
	assert.equal(gradeChoice(choice, ["a"]), false);
	assert.equal(gradeChoice(choice, ["a", "b", "c"]), false);
	assert.equal(gradeChoice({ ...choice, answer: "b" }, ["b"]), true);
});

test("numeric expressions evaluate like a calculator", () => {
	assert.equal(evaluate("2 + 3 * 4"), 14);
	assert.equal(evaluate("2^3^2"), 2 ** 9);
	assert.equal(evaluate("-2^2"), -4);
	assert.ok(Math.abs(evaluate("pi/6") - Math.PI / 6) < 1e-12);
	assert.ok(Math.abs(evaluate("2sqrt(3)") - 2 * Math.sqrt(3)) < 1e-12);
	assert.ok(Math.abs(evaluate("atan2(1, 1)") - Math.PI / 4) < 1e-12);
	assert.ok(Math.abs(evaluate("30°") - Math.PI / 6) < 1e-12);
	assert.equal(evaluate("1.5e-3"), 0.0015);
	assert.throws(() => evaluate("process.exit()"));
	assert.throws(() => evaluate("2 +"));
});

test("numeric grading honours tolerance, relative tolerance, and units", () => {
	const check: NumericCheck = { id: "n", type: "numeric", prompt: "", covers: [0], answer: 0.5236, tolerance: 0.001, unit: "rad", explanation: "" };
	assert.equal(gradeNumeric(check, "pi/6").correct, true);
	assert.equal(gradeNumeric(check, "0.5236 rad").correct, true);
	assert.equal(gradeNumeric(check, "0.53").correct, false);
	const rel: NumericCheck = { ...check, answer: 1000, tolerance: 0.01, relative: true, unit: undefined };
	assert.equal(gradeNumeric(rel, "1009").correct, true);
	assert.equal(gradeNumeric(rel, "1011").correct, false);
	const vector = gradeNumeric({ ...check, answer: 2, unit: undefined }, "(6, -4)");
	assert.equal(vector.correct, false);
	assert.equal(vector.error, undefined, "a vector is graded as a wrong answer, not rejected");
	assert.ok(vector.note);
	assert.equal(gradeNumeric({ ...check, answer: 2, unit: undefined }, "[1, atan2(1, 2)]").error, undefined);
	assert.equal(gradeNumeric({ ...check, answer: Math.atan2(1, 2), tolerance: 1e-6, unit: undefined }, "atan2(1, 2)").correct, true);
	const bad = gradeNumeric(check, "about half");
	assert.equal(bad.correct, false);
	assert.ok(bad.error);
});

const free: FreeCheck = {
	id: "f",
	type: "free",
	prompt: "Why can a 2-link arm reach a point two ways?",
	covers: [0],
	rubric: [
		{ idea: "The elbow can bend either way.", accept: ["elbow up or down"] },
		{ idea: "Both configurations put the end effector at the same point.", accept: [] },
	],
	model_answer: "",
};

test("free verdict passes only when every idea is present", () => {
	const v = combineFreeVerdict(free, [{ index: 0, status: "present" }, { index: 1, status: "present" }], false);
	assert.equal(v.outcome, "pass");
});

test("free verdict fails on a missing or contradicted idea and names it", () => {
	const v = combineFreeVerdict(free, [{ index: 0, status: "present" }, { index: 1, status: "contradicted" }], false);
	assert.equal(v.outcome, "fail");
	assert.deepEqual(v.missed, [free.rubric[1]!.idea]);
});

test("unclear ideas earn one follow-up, then the benefit of the doubt", () => {
	const judgments = [{ index: 0, status: "unclear" as const }, { index: 1, status: "present" as const }];
	const first = combineFreeVerdict(free, judgments, false);
	assert.equal(first.outcome, "follow_up");
	assert.ok(first.followUp);
	assert.equal(combineFreeVerdict(free, judgments, true).outcome, "pass");
});

test("missing judgments are treated as unclear, not as failures", () => {
	assert.equal(combineFreeVerdict(free, [{ index: 0, status: "present" }], false).outcome, "follow_up");
});

test("Jev probabilities map to statuses with a borderline band", () => {
	assert.equal(statusFromProbability(0.77), "present");
	assert.equal(statusFromProbability(0.1), "missing");
	assert.equal(statusFromProbability(0.45), "unclear");
	assert.equal(statusFromProbability(0.9, 0.8), "contradicted");
});
