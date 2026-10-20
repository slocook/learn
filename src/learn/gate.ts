import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gradeFree } from "../gate/free-grader.ts";
import { gradeChoice, gradeNumeric } from "../gate/grade.ts";
import { runCodeCheck } from "../labs/run.ts";
import type { Check, ChoiceCheck, CodeCheck, FreeCheck, Gate, KNode, NumericCheck, Topic } from "../types.ts";
import { showChoice } from "../ui/choice.ts";
import { closeNode, startLesson } from "./lesson.ts";
import type { GateRunState, LearnRuntime } from "./runtime.ts";
import { refreshProgressWidget } from "./widgets.ts";

function shuffled<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

function loadGate(rt: LearnRuntime, nodeId: string): Gate | undefined {
	const gate = rt.store.getGate(nodeId);
	if (gate && !rt.store.verifyGate(gate)) {
		rt.note(`The gate for "${nodeId}" was edited after it was frozen; using the edited version.`, "warning");
	}
	return gate;
}

function currentCheck(rt: LearnRuntime, run: GateRunState): Check | undefined {
	const gate = loadGate(rt, run.node);
	return gate?.checks.find((c) => c.id === run.checkIds[run.index]);
}

/** Start the gate for a node: the current lesson's node, or a ready node to test out of. */
export async function startGate(rt: LearnRuntime, ctx: ExtensionContext, node: KNode): Promise<void> {
	if (rt.gateRun) {
		ctx.ui.notify("A gate is already in progress. Use /gate cancel to stop it.", "warning");
		return;
	}
	const gate = loadGate(rt, node.id);
	if (!gate) {
		ctx.ui.notify(`"${node.title}" has no gate.`, "error");
		return;
	}
	const topic = rt.activeTopic();
	const lesson = topic?.lesson?.node === node.id ? topic.lesson : undefined;
	const testOut = !lesson;
	const passed = new Set(lesson?.gate.passed_checks ?? []);
	const checkIds = gate.checks.filter((c) => !passed.has(c.id)).map((c) => c.id);
	rt.gateRun = {
		node: node.id,
		topic: topic?.slug,
		testOut,
		counts: !testOut && lesson!.beats_done.length >= node.outline.length,
		checkIds,
		index: 0,
		results: [],
	};
	const remaining = checkIds.length === gate.checks.length ? `${checkIds.length}` : `${checkIds.length} remaining`;
	rt.note(
		`**Gate: ${node.title}**, ${remaining} check${checkIds.length === 1 ? "" : "s"}.` +
			(testOut ? " Testing out: if you pass, the node is done without a lesson." : "") +
			(!testOut && !rt.gateRun.counts ? " Taken before the lesson is finished, so misses don't use up attempts." : ""),
	);
	await advance(rt, ctx);
}

export function cancelGate(rt: LearnRuntime, ctx: ExtensionContext): void {
	if (!rt.gateRun) {
		ctx.ui.notify("No gate in progress.", "info");
		return;
	}
	rt.gateRun = undefined;
	rt.note("Gate cancelled. No attempt was used for the unanswered check.");
	refreshProgressWidget(rt, ctx);
}

/** Work through checks until one needs a chat answer, or the gate is finished. */
async function advance(rt: LearnRuntime, ctx: ExtensionContext): Promise<void> {
	const run = rt.gateRun;
	if (!run) return;
	while (run.index < run.checkIds.length) {
		const check = currentCheck(rt, run);
		if (!check) {
			run.index++;
			continue;
		}
		const label = `check ${run.index + 1}/${run.checkIds.length}`;
		if (check.type === "choice") {
			if (!(await askChoice(rt, ctx, run, check, label))) return cancelGate(rt, ctx);
			run.index++;
		} else if (check.type === "numeric") {
			if (!(await askNumeric(rt, ctx, run, check, label))) return cancelGate(rt, ctx);
			run.index++;
		} else if (check.type === "free") {
			rt.note(`**Gate ${label}**\n\n${check.prompt}\n\n*Answer in your next message, in your own words.*`);
			run.awaiting = { kind: "free", checkId: check.id };
			refreshProgressWidget(rt, ctx);
			return;
		} else {
			rt.note(
				`**Gate ${label}**\n\n${check.prompt}\n\nImplement it in \`${check.solution_file}\`, then send any message to run the tests.`,
			);
			run.awaiting = { kind: "code", checkId: check.id };
			refreshProgressWidget(rt, ctx);
			return;
		}
	}
	await finishGate(rt, ctx);
}

async function askChoice(rt: LearnRuntime, ctx: ExtensionContext, run: GateRunState, check: ChoiceCheck, label: string): Promise<boolean> {
	// Reshuffle on every attempt so a retry can't be passed by remembering a position.
	const options = shuffled(check.options);
	const answer = await showChoice(ctx, {
		title: `Gate · ${label}`,
		question: check.prompt,
		options: options.map((o) => ({ label: o.label })),
		multi: Array.isArray(check.answer),
		allowDontKnow: true,
		allowNote: true,
		feedback: (a) => {
			const right = a.kind === "options" && gradeChoice(check, a.selected.map((i) => options[i]!.value));
			return right
				? { correct: a.kind === "options" ? a.selected : [], verdict: "correct", lines: [check.explanation] }
				: {
						// The answer stays hidden: the learner retries this same question after help.
						correct: [],
						verdict: a.kind === "dont_know" ? "dont_know" : "incorrect",
						lines: ["Not this time. Your teacher will help, and you'll retry this same question."],
					};
		},
	});
	if (!answer) return false;
	const values = answer.kind === "options" ? answer.selected.map((i) => options[i]!.value) : [];
	const passed = answer.kind === "options" && gradeChoice(check, values);
	const picked = answer.kind === "options" ? answer.selected.map((i) => `"${options[i]!.label}"`).join(", ") : "I don't know";
	recordResult(rt, ctx, run, check, passed, `chose ${picked}${answer.note ? `; note: ${answer.note}` : ""}`, undefined, picked);
	return true;
}

async function askNumeric(rt: LearnRuntime, ctx: ExtensionContext, run: GateRunState, check: NumericCheck, label: string): Promise<boolean> {
	rt.note(`**Gate ${label}**\n\n${check.prompt}${check.unit ? `\n\n*Unit: ${check.unit}*` : ""}`);
	for (;;) {
		const input = await ctx.ui.input(`Gate ${label}: your answer${check.unit ? ` (${check.unit})` : ""}`, "a number or expression, e.g. pi/6 or 2*sqrt(3)");
		if (input === undefined) return false;
		const grade = gradeNumeric(check, input);
		if (grade.error) {
			ctx.ui.notify(grade.error, "warning");
			continue;
		}
		const detail = grade.note ? `answered ${input} (${grade.note})` : `answered ${input} (= ${grade.value})`;
		recordResult(rt, ctx, run, check, grade.correct, detail, undefined, input);
		if (grade.correct) rt.note(`✓ Correct. ${check.explanation}`, "success");
		return true;
	}
}

/** Called from the input hook while a gate check is waiting for a chat answer. */
export async function handleGateAnswer(rt: LearnRuntime, ctx: ExtensionContext, text: string): Promise<void> {
	const run = rt.gateRun;
	if (!run?.awaiting) return;
	const check = currentCheck(rt, run);
	if (!check) {
		run.awaiting = undefined;
		return advance(rt, ctx);
	}
	const awaiting = run.awaiting;
	run.awaiting = undefined;
	refreshProgressWidget(rt, ctx);

	if (check.type === "code") {
		rt.note("Running your solution against the tests…");
		const result = await runCodeCheck(rt.cwd, check as CodeCheck, ctx.signal);
		recordResult(rt, ctx, run, check, result.passed, result.summary);
		rt.note(result.passed ? "✓ All tests pass." : `✗ ${result.summary}`, result.passed ? "success" : "warning");
		run.index++;
		return advance(rt, ctx);
	}

	const free = check as FreeCheck;
	const answer =
		awaiting.kind === "follow_up" && run.followUp
			? { answer: run.followUp.firstAnswer, followUp: { question: run.followUp.question, answer: text } }
			: { answer: text };
	let verdict;
	try {
		verdict = await gradeFree(rt.agentEnv(ctx), free, answer, awaiting.kind === "follow_up");
	} catch (e) {
		rt.note(`Grading failed (${(e as Error).message}). Your answer wasn't counted; send it again to retry.`, "error");
		run.awaiting = awaiting;
		refreshProgressWidget(rt, ctx);
		return;
	}
	if (verdict.outcome === "follow_up") {
		run.followUp = { question: verdict.followUp!, firstAnswer: text };
		run.awaiting = { kind: "follow_up", checkId: free.id };
		rt.note(`**Follow-up:** ${verdict.followUp}`);
		refreshProgressWidget(rt, ctx);
		return;
	}
	run.followUp = undefined;
	const passed = verdict.outcome === "pass";
	const fullAnswer = answer.followUp ? `${answer.answer}\n(follow-up) ${answer.followUp.answer}` : answer.answer;
	recordResult(rt, ctx, run, free, passed, passed ? "all ideas present" : `missed: ${verdict.missed.join("; ")}`, verdict.missed, fullAnswer);
	if (passed) {
		rt.note(`✓ That's it. A model answer, for comparison:\n\n${free.model_answer}`, "success");
	} else {
		rt.lastFailedFree = { node: run.node, checkId: free.id, answer: fullAnswer, missed: verdict.missed };
		rt.note(
			`✗ Not yet. Missing: ${verdict.missed.map((m) => `*${m}*`).join("; ")}\n\nYour teacher will help, then you'll retry this question. (Think the grade is wrong? /dispute)`,
			"warning",
		);
	}
	run.index++;
	return advance(rt, ctx);
}

function recordResult(
	rt: LearnRuntime,
	_ctx: ExtensionContext,
	run: GateRunState,
	check: Check,
	passed: boolean,
	detail: string,
	missed?: string[],
	answer?: string,
): void {
	run.results.push({ checkId: check.id, passed, detail, missed, answer });
	const store = rt.store;
	store.appendEvidence({
		kind: "gate_attempt",
		node: run.node,
		topic: run.topic,
		data: { check: check.id, type: check.type, passed, counted: run.counts, test_out: run.testOut, detail, answer },
	});
	const topic = run.topic ? store.getTopic(run.topic) : undefined;
	if (topic?.lesson?.node === run.node) {
		const g = topic.lesson.gate;
		if (passed && !g.passed_checks.includes(check.id)) g.passed_checks.push(check.id);
		if (!passed && run.counts) g.attempts[check.id] = (g.attempts[check.id] ?? 0) + 1;
		store.saveTopic(topic);
	}
}

async function finishGate(rt: LearnRuntime, ctx: ExtensionContext): Promise<void> {
	const run = rt.gateRun!;
	rt.gateRun = undefined;
	refreshProgressWidget(rt, ctx);
	const store = rt.store;
	const node = store.getNode(run.node)!;
	const gate = loadGate(rt, run.node)!;
	const topic = run.topic ? store.getTopic(run.topic) : undefined;
	const passedIds = new Set([...(topic?.lesson?.node === run.node ? topic.lesson.gate.passed_checks : []), ...run.results.filter((r) => r.passed).map((r) => r.checkId)]);
	const allPassed = gate.checks.every((c) => passedIds.has(c.id));

	if (allPassed) {
		if (run.testOut) store.appendEvidence({ kind: "test_out", node: node.id, topic: run.topic });
		await closeNode(rt, ctx, node.id, "pass");
		return;
	}
	const failed = run.results.filter((r) => !r.passed);
	if (run.testOut) {
		rt.note(`Not yet: that's fine, now you know where to start. Beginning the lesson on "${node.title}".`);
		if (topic) await startLesson(rt, ctx, topic, node);
		return;
	}
	const attempts = topic?.lesson?.gate.attempts ?? {};
	const max = rt.config.gate.attempts;
	const exhausted = run.counts && failed.some((f) => (attempts[f.checkId] ?? 0) >= max);
	if (exhausted && topic) {
		await exhaustedChoice(rt, ctx, topic, node, failed);
		return;
	}
	const lines = failed.map((f) => {
		const check = gate.checks.find((c) => c.id === f.checkId)!;
		const used = run.counts ? ` (attempt ${attempts[f.checkId] ?? 0}/${max})` : " (early try, not counted)";
		const missed = f.missed?.length ? `\n  Missed ideas: ${f.missed.join("; ")}` : "";
		const answer = f.answer ? `\n  Learner's answer: ${f.answer.replace(/\n/g, " ")}` : "";
		return `- ${check.id} (${check.type}): "${check.prompt}"${used}\n  Result: ${f.detail}${missed}${answer}`;
	});
	const passedNow = run.results.filter((r) => r.passed).map((r) => r.checkId);
	rt.pi.sendMessage(
		{
			customType: "learn-gate-result",
			content:
				`Gate result for "${node.title}": ${failed.length} check${failed.length === 1 ? "" : "s"} not passed` +
				(passedNow.length ? ` (passed: ${passedNow.join(", ")})` : "") +
				`.\n${lines.join("\n")}\n\n` +
				"Reteach the missed ideas from a different angle than before; don't reveal or rehearse the answers. " +
				"When the learner is ready, call offer_gate; they will retry the same question(s).",
			display: true,
			details: { node: node.id, failed: failed.map((f) => f.checkId) },
		},
		{ triggerTurn: true },
	);
}

async function exhaustedChoice(
	rt: LearnRuntime,
	ctx: ExtensionContext,
	topic: Topic,
	node: KNode,
	failed: GateRunState["results"],
): Promise<void> {
	const answer = await showChoice(ctx, {
		title: "Gate attempts used up",
		question: `"${node.title}" hasn't clicked yet after ${rt.config.gate.attempts} tries. How do you want to move on?`,
		options: [
			{ label: "Pass with assistance", description: "Count it as learned with help; it's marked on the map." },
			{ label: "Mark as weak and move on", description: "Unlocks what's next; flagged as shaky on the map." },
			{ label: "Split it", description: "Find the missing foundation underneath and learn that first." },
			{ label: "Keep working on it", description: "Stay on this node with your teacher. No attempts are reset." },
		],
	});
	const pick = answer?.kind === "options" ? answer.selected[0] : 3;
	if (pick === 0) return closeNode(rt, ctx, node.id, "assist");
	if (pick === 1) return closeNode(rt, ctx, node.id, "weak");
	if (pick === 2) {
		const { splitNode } = await import("./split.ts");
		return splitNode(rt, ctx, topic, node, failed);
	}
	rt.note("Staying on this node. Your teacher will keep helping; /pass closes the gate if you decide it's done.");
}
