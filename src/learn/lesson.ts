import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAgentPrompt, runAgent } from "../agents/runner.ts";
import { SummarySchema } from "../agents/schemas.ts";
import { parseModelRef } from "../config.ts";
import { isSatisfied, nextNode, topicProgress } from "../graph/graph.ts";
import { type NodeEvent, transition } from "../graph/state.ts";
import { writeMapFiles } from "../map/render.ts";
import type { KNode, LessonProgress, Topic } from "../types.ts";
import type { LearnRuntime } from "./runtime.ts";
import { refreshProgressWidget } from "./widgets.ts";

export const LESSON_START = "learn-lesson-start";

export function newLessonProgress(nodeId: string): LessonProgress {
	return {
		node: nodeId,
		started_at: new Date().toISOString(),
		beats_done: [],
		turns: 0,
		practice: {},
		practice_correct: [],
		gate: { passed_checks: [], attempts: {} },
	};
}

/** Index of the first beat not yet done, or outline.length when all are done. */
export function currentBeat(node: KNode, lesson: LessonProgress): number {
	for (let i = 0; i < node.outline.length; i++) if (!lesson.beats_done.includes(i)) return i;
	return node.outline.length;
}

const STATE_LABEL: Record<string, string> = {
	passed: "learned",
	"passed-assisted": "learned with help; may need reinforcing",
	"passed-override": "closed by the learner; may need reinforcing",
	weak: "shaky; reinforce it as you go",
	placed: "assumed known from placement; if it turns out shaky, call propose_unplace",
};

/** The lesson brief, appended to the system prompt on every turn of a lesson. */
export function buildBrief(rt: LearnRuntime, topic: Topic, node: KNode): string {
	const lesson = topic.lesson!;
	const store = rt.store;
	const nodes = store.loadNodes();
	const progress = topicProgress(topic, nodes);
	const position = topic.nodes.filter((id) => nodes.get(id)?.state !== "placed").indexOf(node.id) + 1;
	const taughtTotal = topic.nodes.filter((id) => nodes.get(id)?.state !== "placed").length;
	const out: string[] = [loadAgentPrompt(rt.cwd, "teacher"), "", "---", "", "## Current lesson", ""];
	out.push(`**Topic:** ${topic.title}. Goal: ${topic.goal}`);
	out.push(`**Node:** ${node.title} (\`${node.id}\`, ${node.kind}), lesson ${position} of ${taughtTotal}; ${progress.done}/${progress.total} nodes done.`);

	const evidence = store.readEvidence((e) => e.kind === "lesson_summary");
	const summaryOf = new Map(evidence.map((e) => [e.node, String(e.data?.evidence ?? "")]));
	if (node.requires.length > 0) {
		out.push("", "**Builds on** (connect explicitly to these):");
		for (const id of node.requires) {
			const req = nodes.get(id);
			if (!req) continue;
			const ev = summaryOf.get(id);
			out.push(`- ${req.title} [${STATE_LABEL[req.state] ?? req.state}]${ev ? `: ${ev}` : ""}`);
		}
	}

	const cur = currentBeat(node, lesson);
	out.push("", "**Outline** (teach in order; call beat_done when a beat has landed):");
	node.outline.forEach((b, i) => {
		const status = lesson.beats_done.includes(i) ? "[done] " : i === cur ? "[current] " : "";
		out.push(`${i + 1}. ${status}${b.point}${b.motivation ? `\n   Motivation: ${b.motivation}` : ""}`);
	});

	const gate = store.getGate(node.id);
	if (gate) {
		out.push("", "**Gate questions** (teach toward the ideas they test; never reveal answers or rehearse these questions):");
		for (const c of gate.checks) {
			const passed = lesson.gate.passed_checks.includes(c.id) ? " [passed]" : "";
			const attempts = lesson.gate.attempts[c.id] ? ` [${lesson.gate.attempts[c.id]}/${rt.config.gate.attempts} attempts used]` : "";
			out.push(`- ${c.id} (${c.type})${passed}${attempts}: ${c.prompt}`);
		}
	}
	if (node.lab?.built && node.lab.path) {
		out.push("", `**Lab:** \`${node.lab.path}\` (${node.lab.type}). ${node.lab.justification}`);
	}

	const budget = node.outline.length * rt.config.lesson.turns_per_beat;
	const practiceUsed = lesson.practice[String(cur)] ?? 0;
	out.push(
		"",
		`**Status:** beat ${Math.min(cur + 1, node.outline.length)} of ${node.outline.length} · learner turns ${lesson.turns}/${budget} · practice questions this beat ${practiceUsed}/${rt.config.gate.practice_per_beat}`,
	);
	if (cur >= node.outline.length) out.push("", "**All beats are done. The gate is ready: call offer_gate now.**");
	else if (lesson.turns > budget) out.push("", "**Over the turn budget.** Wrap up the current beat, mark it done, and move toward the gate.");
	if (topic.backlog.length > 0) out.push("", `Parked tangents for this topic: ${topic.backlog.length} (the learner can see them with /map).`);
	return out.join("\n");
}

/** Begin (or resume) teaching a node: mark it learning, record progress, and prompt the teacher. */
export async function startLesson(rt: LearnRuntime, ctx: ExtensionContext, topic: Topic, node: KNode): Promise<void> {
	const store = rt.store;
	if (node.state !== "learning") {
		node.state = transition(node.state, "start");
		store.saveNode(node, rt.titles());
	}
	const resuming = topic.lesson?.node === node.id;
	if (!resuming) topic.lesson = newLessonProgress(node.id);
	store.saveTopic(topic);
	rt.setActiveTopic(topic.slug);

	const teacher = rt.config.models.teacher;
	if (teacher.model && teacher.model !== "inherit") {
		const ref = parseModelRef(teacher.model);
		const model = ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
		if (model && (ctx.model?.id !== model.id || ctx.model?.provider !== model.provider)) await rt.pi.setModel(model);
		if (teacher.thinking) rt.pi.setThinkingLevel(teacher.thinking);
	}

	if (node.lab && !node.lab.built && node.lab.type === "exploration") {
		const { buildLab } = await import("../labs/build.ts");
		await buildLab(rt, ctx, node).catch((e) => rt.note(`Couldn't build the lab: ${(e as Error).message}. Continuing without it.`, "warning"));
	}

	refreshProgressWidget(rt, ctx);
	rt.pi.sendMessage(
		{
			customType: LESSON_START,
			content: resuming
				? `Resume the lesson on "${node.title}" where it left off (see the outline status in your instructions).`
				: `Begin the lesson on "${node.title}". Start with beat 1: motivate it, then establish it.`,
			display: true,
			details: { node: node.id, title: node.title, topic: topic.slug, resuming },
		},
		{ triggerTurn: true },
	);
}

/** Plain-text transcript of the current lesson, for the summarizer. */
export function lessonTranscript(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch() as Array<{ type: string; message?: any; customType?: string }>;
	let start = 0;
	branch.forEach((e, i) => {
		if (e.type === "custom_message" && e.customType === LESSON_START) start = i;
		if (e.type === "message" && e.message?.role === "custom" && e.message?.customType === LESSON_START) start = i;
	});
	const lines: string[] = [];
	for (const e of branch.slice(start)) {
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		const text = (c: any) =>
			typeof c === "string" ? c : Array.isArray(c) ? c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
		if (m.role === "user") lines.push(`LEARNER: ${text(m.content)}`);
		else if (m.role === "assistant") {
			const t = text(m.content);
			if (t.trim()) lines.push(`TEACHER: ${t}`);
		} else if (m.role === "toolResult" && (m.toolName === "quiz" || m.toolName === "ask_user_question")) {
			lines.push(`[${m.toolName}] ${text(m.content)}`);
		}
	}
	const joined = lines.join("\n\n");
	return joined.length > 60_000 ? `…${joined.slice(-60_000)}` : joined;
}

async function summarize(rt: LearnRuntime, ctx: ExtensionContext, topic: Topic | undefined, node: KNode, outcome: NodeEvent): Promise<void> {
	const transcript = lessonTranscript(ctx);
	if (transcript.length < 200) return;
	try {
		const date = new Date().toISOString().slice(0, 10);
		const { output } = await runAgent(rt.agentEnv(ctx), {
			role: "summarizer",
			prompt: "summarizer",
			label: `notes: ${node.title}`,
			task:
				`Date: ${date}\nNode: ${node.title}\nOutline:\n${node.outline.map((b, i) => `${i + 1}. ${b.point}`).join("\n")}\n` +
				`Outcome: ${outcome}\n\n## Transcript\n\n${transcript}`,
			output: SummarySchema,
		});
		if (!output) return;
		rt.store.appendNotes(node.id, output.notes);
		rt.store.appendEvidence({ kind: "lesson_summary", node: node.id, topic: topic?.slug, data: { evidence: output.evidence, outcome } });
	} catch (e) {
		rt.note(`Couldn't write lesson notes: ${(e as Error).message}`, "warning");
	}
}

const OUTCOME_TEXT: Partial<Record<NodeEvent, string>> = {
	pass: "passed",
	assist: "passed with assistance",
	weak: "marked weak",
	override: "closed by override",
};

/**
 * Close a node with an outcome, write notes, and offer the next lesson. The only place nodes
 * become satisfied during a lesson.
 */
export async function closeNode(rt: LearnRuntime, ctx: ExtensionContext, nodeId: string, event: NodeEvent): Promise<void> {
	const store = rt.store;
	const node = store.getNode(nodeId);
	if (!node) return;
	const topic = rt.activeTopic();
	const wasLesson = topic?.lesson?.node === nodeId;
	node.state = transition(node.state, event);
	store.saveNode(node, rt.titles());
	store.appendEvidence({ kind: "state", node: nodeId, topic: topic?.slug, data: { event, state: node.state } });

	rt.note(`**${node.title}**: ${OUTCOME_TEXT[event] ?? node.state}.`, event === "pass" ? "success" : "info");
	if (wasLesson) await summarize(rt, ctx, topic, node, event);

	const nodes = rt.recompute();
	if (!topic) return refreshProgressWidget(rt, ctx);
	if (wasLesson) topic.lesson = undefined;
	const goalDone = topic.goal_node ? isSatisfied(nodes.get(topic.goal_node)?.state ?? "locked") : false;
	const next = nextNode(topic, nodes);
	if (goalDone || !next) topic.status = goalDone ? "done" : topic.status;
	store.saveTopic(topic);
	writeMapFiles(store.paths.maps, topic, nodes);
	refreshProgressWidget(rt, ctx);

	if (goalDone) {
		rt.note(`🎉 **${topic.title} complete.** Your notes are in \`${path.relative(rt.cwd, store.paths.knowledge)}/\` and the map in \`maps/${topic.slug}.md\`.`, "success");
		return;
	}
	if (!next) {
		rt.note("No node is ready to learn next. Check /map: something may need un-placing or a decision.", "warning");
		return;
	}
	if (!wasLesson) return;
	const answer = ctx.hasUI ? await ctx.ui.select(`Next: ${next.title}`, ["Start the next lesson", "Stop here for now"]) : undefined;
	if (answer === "Start the next lesson") await startLesson(rt, ctx, store.getTopic(topic.slug)!, next);
	else rt.note(`Next up: **${next.title}**. Run /learn to continue.`);
}

/** Write learner-visible files for a topic: the map. */
export function refreshTopicFiles(rt: LearnRuntime, topic: Topic): void {
	const store = rt.store;
	fs.mkdirSync(store.paths.maps, { recursive: true });
	writeMapFiles(store.paths.maps, topic, store.loadNodes());
}
