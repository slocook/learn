import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type AgentToolUpdateCallback, defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { activity, formatElapsed, formatTokens, type RunRecord } from "../agents/activity.ts";
import { resolveRoleModel, runAgent } from "../agents/runner.ts";
import { DiagramResultSchema, ResearchSchema } from "../agents/schemas.ts";
import { webTools } from "../agents/tools/web.ts";
import { canTransition, transition } from "../graph/state.ts";
import { diagramTools } from "../viz/tools.ts";
import { closeNode, currentBeat, refreshTopicFiles, startLesson } from "./lesson.ts";
import type { LearnRuntime } from "./runtime.ts";
import { refreshProgressWidget } from "./widgets.ts";

interface ProgressDetails {
	run?: Pick<RunRecord, "role" | "label" | "model" | "status" | "step" | "tokens" | "toolCalls" | "startedAt" | "endedAt" | "error">;
	file?: string;
}

function progress(run: RunRecord): ProgressDetails {
	const { role, label, model, status, step, tokens, toolCalls, startedAt, endedAt, error } = run;
	return { run: { role, label, model, status, step, tokens, toolCalls, startedAt, endedAt, error } };
}

function streamTo(onUpdate: AgentToolUpdateCallback<ProgressDetails> | undefined) {
	return (run: RunRecord) => onUpdate?.({ content: [{ type: "text", text: `${run.role}: ${run.step}` }], details: progress(run) });
}

function renderProgress(details: ProgressDetails | undefined, theme: Theme): string {
	const r = details?.run;
	if (!r) return "";
	const elapsed = formatElapsed((r.endedAt ?? Date.now()) - r.startedAt);
	const icon = r.status === "running" ? theme.fg("accent", "⠿") : r.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const step = r.status === "running" ? ` · ${r.step}` : r.status === "failed" ? ` · ${r.error ?? "failed"}` : "";
	return `${icon} ${theme.fg("text", r.role)} ${theme.fg("dim", `${r.model.slice(r.model.indexOf("/") + 1)} · ${elapsed} · ${formatTokens(r.tokens)} tok · ${r.toolCalls} tool calls${step}`)}`;
}

function noLesson() {
	return { content: [{ type: "text" as const, text: "There is no lesson in progress. These tools only work inside a /learn lesson." }], details: {} };
}

export function registerTeacherTools(pi: ExtensionAPI, rt: LearnRuntime): void {
	pi.registerTool(
		defineTool({
			name: "beat_done",
			label: "beat done",
			description: "Mark an outline beat of the current lesson as established. Beats go in order; call this once a beat has clearly landed.",
			promptSnippet: "beat_done: mark the current lesson beat as established (in order).",
			parameters: Type.Object({
				beat: Type.Integer({ minimum: 1, description: "1-based beat number from the outline." }),
				note: Type.Optional(Type.String({ description: "What landed, or what was shaky, in a few words." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const lesson = rt.activeLesson();
				if (!lesson?.topic.lesson) return noLesson();
				const { topic, node } = lesson;
				const lp = topic.lesson!;
				const expected = currentBeat(node, lp);
				const i = params.beat - 1;
				if (lp.beats_done.includes(i)) return { content: [{ type: "text", text: `Beat ${params.beat} is already done.` }], details: {} };
				if (i !== expected) {
					throw new Error(
						expected >= node.outline.length
							? "All beats are already done: call offer_gate."
							: `Beats go in order: beat ${expected + 1} ("${node.outline[expected]!.point}") comes first.`,
					);
				}
				lp.beats_done.push(i);
				rt.store.saveTopic(topic);
				rt.store.appendEvidence({ kind: "beat", node: node.id, topic: topic.slug, data: { beat: params.beat, note: params.note } });
				refreshProgressWidget(rt, ctx);
				const next = currentBeat(node, lp);
				const text =
					next >= node.outline.length
						? "All beats are done. The gate is ready: call offer_gate now."
						: `Beat ${params.beat} done. Next, beat ${next + 1}: ${node.outline[next]!.point}`;
				return { content: [{ type: "text", text }], details: {} };
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("beat ")) + theme.fg("success", `✓ ${args.beat}`) + (args.note ? theme.fg("dim", ` · ${args.note}`) : ""), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "park",
			label: "park",
			description: "Save an off-outline tangent to the topic's backlog so the lesson can return to the current beat.",
			promptSnippet: "park: save a tangent for later and return to the current beat.",
			parameters: Type.Object({ tangent: Type.String({ description: "The tangent, phrased as a question or topic to come back to." }) }),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const lesson = rt.activeLesson();
				if (!lesson) return noLesson();
				const { topic, node } = lesson;
				topic.backlog.push({ text: params.tangent, from_node: node.id, at: new Date().toISOString() });
				rt.store.saveTopic(topic);
				rt.store.appendEvidence({ kind: "park", node: node.id, topic: topic.slug, data: { tangent: params.tangent } });
				refreshTopicFiles(rt, topic);
				refreshProgressWidget(rt, ctx);
				return { content: [{ type: "text", text: "Parked. Tell the learner it's saved (visible in /map), then return to the current beat." }], details: {} };
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("park ")) + theme.fg("muted", args.tangent), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "view_rubric",
			label: "view rubric",
			description: "Show how a gate check is graded, to diagnose a failed attempt. Never reveal it to the learner or teach its wording.",
			parameters: Type.Object({ check: Type.String({ description: "Check id, e.g. c1." }) }),
			async execute(_id, params) {
				const lesson = rt.activeLesson();
				if (!lesson) return noLesson();
				const gate = rt.store.getGate(lesson.node.id);
				const c = gate?.checks.find((x) => x.id === params.check);
				if (!c) throw new Error(`no check "${params.check}" in this gate`);
				rt.store.appendEvidence({ kind: "view_rubric", node: lesson.node.id, topic: lesson.topic.slug, data: { check: c.id } });
				let text: string;
				if (c.type === "free") text = c.rubric.map((r, i) => `${i + 1}. ${r.idea}${r.reject_if ? ` (fails if: ${r.reject_if})` : ""}`).join("\n");
				else if (c.type === "choice") text = `Answer: ${JSON.stringify(c.answer)}\nOptions: ${c.options.map((o) => `${o.value}=${o.label}`).join(" | ")}\nWhy: ${c.explanation}`;
				else if (c.type === "numeric") text = `Answer: ${c.answer} ± ${c.tolerance}${c.relative ? " (relative)" : ""}${c.unit ? ` ${c.unit}` : ""}\nWhy: ${c.explanation}`;
				else text = `Tests: ${c.test_file} against ${c.solution_file}`;
				return { content: [{ type: "text", text: `${text}\n\nUse this to diagnose; do not reveal it or rehearse its wording.` }], details: {} };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "offer_gate",
			label: "offer gate",
			description: "Offer the learner the gate for the current node. If they accept, it starts after your turn ends.",
			promptSnippet: "offer_gate: offer the node's gate when all beats are done (or the learner asks).",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				const lesson = rt.activeLesson();
				if (!lesson?.topic.lesson) return noLesson();
				const { node, topic } = lesson;
				const ready = currentBeat(node, topic.lesson!) >= node.outline.length;
				const ok = ctx.hasUI
					? await ctx.ui.confirm(`Take the gate for "${node.title}"?`, ready ? "All beats are done." : "Not every beat is done yet; misses won't use up attempts.")
					: false;
				if (!ok) return { content: [{ type: "text", text: "The learner wants to keep going first. Continue the lesson." }], details: {} };
				rt.pendingGate = node.id;
				return {
					content: [{ type: "text", text: "The learner accepted. The gate starts as soon as your turn ends: end it now with one short encouraging line." }],
					details: {},
					terminate: true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "propose_pass",
			label: "propose pass",
			description: "Propose closing the current node's gate because a check is clearly flawed. The learner decides.",
			parameters: Type.Object({ reason: Type.String() }),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const lesson = rt.activeLesson();
				if (!lesson) return noLesson();
				const ok = ctx.hasUI && (await ctx.ui.confirm(`Close the gate for "${lesson.node.title}"?`, `The teacher suggests it: ${params.reason}`));
				if (!ok) return { content: [{ type: "text", text: "The learner declined. The gate stays as it is." }], details: {} };
				rt.store.appendEvidence({ kind: "override", node: lesson.node.id, topic: lesson.topic.slug, data: { by: "teacher-proposal", reason: params.reason } });
				setTimeout(() => void closeNode(rt, ctx, lesson.node.id, "override"), 0);
				return { content: [{ type: "text", text: "The learner closed the gate. Wrap up in one line; the next lesson will be offered." }], details: {}, terminate: true };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "propose_unplace",
			label: "propose unplace",
			description: "A prerequisite marked as already known turns out to be shaky. Propose learning it first; the learner decides.",
			parameters: Type.Object({ node: Type.String({ description: "Id of the placed prerequisite node." }), reason: Type.String() }),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const lesson = rt.activeLesson();
				if (!lesson) return noLesson();
				const target = rt.store.getNode(params.node);
				if (!target || target.state !== "placed") throw new Error(`"${params.node}" is not a node marked as already known`);
				const ok = ctx.hasUI && (await ctx.ui.confirm(`Learn "${target.title}" first?`, params.reason));
				if (!ok) return { content: [{ type: "text", text: "The learner declined. Continue, filling the gap briefly as you go." }], details: {} };
				setTimeout(() => void unplace(rt, ctx, target.id), 0);
				return { content: [{ type: "text", text: "Agreed. The current lesson pauses and that node is taught first. End your turn with one short line." }], details: {}, terminate: true };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "research",
			label: "research",
			description: "Verify a fact or look something up with the researcher subagent (web search with sources). Use whenever you're unsure.",
			promptSnippet: "research: verify facts with a web-research subagent before stating them.",
			parameters: Type.Object({ question: Type.String({ description: "A self-contained question; the researcher sees nothing else." }) }),
			async execute(_id, params, signal, onUpdate, ctx) {
				const env = rt.agentEnv(ctx, signal);
				const tools = webTools({ config: rt.config, registry: ctx.modelRegistry, model: resolveRoleModel(env, "researcher").model });
				const { output, run } = await runAgent(env, {
					role: "researcher",
					prompt: "researcher",
					label: params.question.length > 60 ? `${params.question.slice(0, 57)}…` : params.question,
					task: `${params.question}\n\nKeep the brief short and to the point: the tutor needs a verified answer, not a survey.`,
					tools,
					output: ResearchSchema,
					onUpdate: streamTo(onUpdate),
				});
				return { content: [{ type: "text", text: output?.brief ?? "(no brief)" }], details: progress(run) };
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("research ")) + theme.fg("muted", args.question), 0, 0);
			},
			renderResult(result, options, theme) {
				const line = renderProgress(result.details as ProgressDetails, theme);
				if (options.isPartial || !options.expanded) return new Text(line, 0, 0);
				const first = result.content[0];
				return new Text(`${line}\n\n${first?.type === "text" ? first.text : ""}`, 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "visualize",
			label: "visualize",
			description:
				"Have a diagram subagent draw ONE correct, minimal picture and verify it by looking. kind=mermaid for structure (dependencies, flows, sequences, states); kind=svg for geometry (coordinates, vectors, angles, plots). Give a concrete brief listing the few elements to show.",
			promptSnippet: "visualize: get a verified diagram (mermaid for structure, svg for geometry).",
			parameters: Type.Object({
				kind: Type.Union([Type.Literal("mermaid"), Type.Literal("svg")]),
				brief: Type.String({ description: "The one idea and its fewest carrying elements, concretely." }),
			}),
			async execute(_id, params, signal, onUpdate, ctx) {
				const vizDir = rt.store.paths.viz;
				let published: string | undefined;
				let runRef: RunRecord | undefined;
				const tools = diagramTools(params.kind, {
					vizDir,
					browser: rt.config.render.chrome,
					onPreview: (file) => {
						if (runRef) activity.update(runRef, { previews: [...runRef.previews, file], step: `preview ${runRef.previews.length + 1}` });
						const data = fs.readFileSync(file).toString("base64");
						onUpdate?.({ content: [{ type: "image", data, mimeType: "image/png" }], details: runRef ? progress(runRef) : {} });
					},
					onPublish: (name) => {
						published = name;
					},
				});
				const { output, run } = await runAgent(rt.agentEnv(ctx, signal), {
					role: "diagram",
					prompt: "diagram-maker",
					label: `${params.kind}: ${params.brief.slice(0, 50)}`,
					task: `Kind: ${params.kind}\n\nBrief:\n${params.brief}`,
					tools,
					output: DiagramResultSchema,
					onUpdate: (r) => {
						runRef = r;
						streamTo(onUpdate)(r);
					},
				});
				const file = output?.status === "ok" ? (output.file ?? published) : undefined;
				if (!file || !fs.existsSync(path.join(vizDir, file))) {
					return { content: [{ type: "text", text: `No diagram: ${output?.reason ?? "the maker could not produce a correct picture"}. Explain in words instead.` }], details: progress(run) };
				}
				const rel = path.relative(rt.cwd, path.join(vizDir, file));
				const image: ImageContent = { type: "image", data: fs.readFileSync(path.join(vizDir, file)).toString("base64"), mimeType: "image/png" };
				return {
					content: [{ type: "text", text: `Diagram ready and shown to the learner: ${rel}. Refer to it in your explanation; don't narrate every element.` }, image],
					details: { ...progress(run), file: rel },
				};
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold(`visualize ${args.kind} `)) + theme.fg("muted", args.brief.slice(0, 80)), 0, 0);
			},
		}),
	);
}

/** A placed node turned out not to be known: make it ready and teach it before the current node. */
export async function unplace(rt: LearnRuntime, ctx: Parameters<typeof refreshProgressWidget>[1], nodeId: string): Promise<void> {
	const store = rt.store;
	const node = store.getNode(nodeId);
	if (!node || !canTransition(node.state, "unplace")) return;
	node.state = transition(node.state, "unplace");
	store.saveNode(node, rt.titles());
	store.appendEvidence({ kind: "state", node: nodeId, data: { event: "unplace" } });
	const topic = rt.activeTopic();
	if (!topic) return;
	if (!topic.nodes.includes(nodeId)) topic.nodes.unshift(nodeId);
	if (node.outline.length === 0) {
		rt.note(`"${node.title}" was never planned as a lesson, so it has no outline or gate yet. Writing them now…`);
		const { writeGates } = await import("./planning.ts");
		node.outline = [{ point: node.title, motivation: "A prerequisite that turned out to be shaky." }];
		const gates = await writeGates(rt, ctx, topic.goal, "", [{ id: node.id, title: node.title, kind: node.kind, requires: node.requires, outline: node.outline, status: "new" }]);
		const checks = gates.get(node.id);
		if (checks && !store.getGate(node.id)) store.freezeGate(node.id, checks.map((c) => ({ ...c, covers: [0] })));
		store.saveNode(node, rt.titles());
	}
	topic.lesson = undefined;
	store.saveTopic(topic);
	const nodes = rt.recompute();
	refreshTopicFiles(rt, topic);
	refreshProgressWidget(rt, ctx);
	await startLesson(rt, ctx, store.getTopic(topic.slug)!, nodes.get(nodeId)!);
}
