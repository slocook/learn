import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import YAML from "yaml";
import { AgentError, resolveRoleModel, runAgent } from "../agents/runner.ts";
import {
	GatesSchema,
	GoalSchema,
	InterviewSchema,
	LaddersSchema,
	type PlanNodeOut,
	type PlanOut,
	PlanSchema,
	ResearchSchema,
	StrandsSchema,
} from "../agents/schemas.ts";
import { webTools } from "../agents/tools/web.ts";
import { findJev } from "../gate/free-grader.ts";
import { gradeChoice, gradeNumeric } from "../gate/grade.ts";
import { closure, depths, isSatisfied, topoSort } from "../graph/graph.ts";
import { validateChecks, validatePlan } from "../graph/validate.ts";
import { mapLines } from "../map/render.ts";
import { LadderProbe, startRung, strandBudget } from "../placement/probe.ts";
import { NODE_ID_PATTERN } from "../store/store.ts";
import type { Check, ChoiceCheck, KNode, LadderRung, NumericCheck, SelfReport, StrandPlacement, Topic } from "../types.ts";
import { showChoice } from "../ui/choice.ts";
import { showPager } from "../ui/pager.ts";
import { mathText, wrapLines } from "../ui/text.ts";
import { startLesson } from "./lesson.ts";
import type { LearnRuntime } from "./runtime.ts";
import { refreshProgressWidget } from "./widgets.ts";

class PlanCancelled extends Error {}

const SELF_REPORT_OPTIONS: { value: SelfReport; label: string }[] = [
	{ value: "never", label: "Never seen it" },
	{ value: "heard", label: "Heard of it, can't really use it" },
	{ value: "use", label: "Can use it" },
	{ value: "derive", label: "Can derive or explain it" },
];

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "topic"
	);
}

function graphSummary(nodes: Map<string, KNode>): string {
	if (nodes.size === 0) return "(the learner's graph is empty)";
	return [...nodes.values()].map((n) => `- \`${n.id}\`: ${n.title} [${n.state}]`).join("\n");
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function interview(rt: LearnRuntime, ctx: ExtensionContext, request: string): Promise<Static<typeof GoalSchema>> {
	const env = rt.agentEnv(ctx);
	const topics = rt.store.listTopics().map((t) => `- ${t.title}: ${t.goal}`).join("\n") || "(none)";
	const { output: qs } = await runAgent(env, {
		role: "planner",
		prompt: "interviewer",
		label: "clarifying your goal",
		task: `The learner asked to learn: "${request}"\n\nTheir existing topics:\n${topics}\n\nWrite the clarifying questions.`,
		output: InterviewSchema,
	});
	const answers: string[] = [];
	for (const [i, q] of (qs?.questions ?? []).entries()) {
		const a = await showChoice(ctx, {
			title: `Your goal · ${i + 1}/${qs!.questions.length}`,
			question: q.question,
			options: q.options,
			multi: q.multi,
			allowOther: true,
		});
		if (!a) throw new PlanCancelled();
		const text = a.kind === "other" ? a.text : a.kind === "options" ? a.selected.map((s) => q.options[s]!.label).join("; ") : "no preference";
		answers.push(`Q: ${q.question}\nA: ${text}`);
	}
	const { output: goal } = await runAgent(env, {
		role: "planner",
		prompt: "interviewer",
		label: "writing your goal",
		task: `The learner asked to learn: "${request}"\n\nTheir answers:\n${answers.join("\n\n")}\n\nWrite the goal.`,
		output: GoalSchema,
	});
	if (!goal) throw new Error("no goal produced");
	for (;;) {
		const pick = await ctx.ui.select(`Goal: ${goal.goal}`, ["Looks right", "Edit it", "Cancel"]);
		if (pick === "Looks right") break;
		if (pick !== "Edit it") throw new PlanCancelled();
		const edited = await ctx.ui.editor("Edit your learning goal", goal.goal);
		if (edited?.trim()) goal.goal = edited.trim();
	}
	goal.slug = slugify(goal.slug || goal.title);
	let slug = goal.slug;
	for (let n = 2; rt.store.getTopic(slug); n++) slug = `${goal.slug}-${n}`;
	goal.slug = slug;
	return goal;
}

async function research(rt: LearnRuntime, ctx: ExtensionContext, goal: string): Promise<string> {
	const env = rt.agentEnv(ctx);
	const tools = webTools({ config: rt.config, registry: ctx.modelRegistry, model: resolveRoleModel(env, "researcher").model });
	const { output } = await runAgent(env, {
		role: "researcher",
		prompt: "researcher",
		label: "scoping the subject",
		tools,
		task:
			`Write a scope brief for teaching this goal: ${goal}\n\nCover:\n` +
			"1. The core concepts and how they depend on each other.\n" +
			"2. The genuine first principles / unconditional truths the subject rests on (real definitions, universal statements).\n" +
			"3. Standard framings and the usual teaching order, and how the key results could have been discovered.\n" +
			"4. Common misconceptions and gotchas.\n" +
			"5. The prerequisite background a learner needs.",
		output: ResearchSchema,
	});
	return output?.brief ?? "";
}

function checkOk(check: Check): boolean {
	return validateChecks({ id: "ladder", kind: "concept", outline: [] }, [{ ...check, covers: [] }]).length === 0;
}

async function askRung(rt: LearnRuntime, ctx: ExtensionContext, strand: string, n: number, rung: LadderRung): Promise<{ correct: boolean; dontKnow: boolean } | undefined> {
	const check = rung.check;
	const title = `Placement · ${strand} (${n})`;
	if (check.type === "choice") {
		const a = await showChoice(ctx, {
			title,
			question: check.prompt,
			options: check.options.map((o) => ({ label: o.label })),
			multi: Array.isArray(check.answer),
			allowDontKnow: true,
		});
		if (!a) return undefined;
		const correct = a.kind === "options" && gradeChoice(check, a.selected.map((i) => check.options[i]!.value));
		return { correct, dontKnow: a.kind === "dont_know" };
	}
	rt.note(`**${title}**\n\n${check.prompt}`);
	for (;;) {
		const input = await ctx.ui.input(`${title}: your answer (empty = I don't know)`, "a number or expression");
		if (input === undefined) return undefined;
		if (!input.trim()) return { correct: false, dontKnow: true };
		const g = gradeNumeric(check, input);
		if (g.error) {
			ctx.ui.notify(g.error, "warning");
			continue;
		}
		return { correct: g.correct, dontKnow: false };
	}
}

async function placement(rt: LearnRuntime, ctx: ExtensionContext, goal: string, brief: string): Promise<StrandPlacement[]> {
	const env = rt.agentEnv(ctx);
	const nodes = rt.store.loadNodes();
	const passed = [...nodes.values()].filter((n) => isSatisfied(n.state));
	const { output: strandsOut } = await runAgent(env, {
		role: "planner",
		prompt: "placement",
		label: "finding prerequisite strands",
		task:
			`Goal: ${goal}\n\n## Research brief\n${brief}\n\n## Nodes the learner has already passed\n${graphSummary(new Map(passed.map((n) => [n.id, n])))}\n\nList the strands.`,
		output: StrandsSchema,
	});
	const strands: StrandPlacement[] = (strandsOut?.strands ?? []).map((s) => ({ ...s, frontier: -1, ladder: [], asked: [] }));
	if (strands.length === 0) return [];

	rt.note(`**Placement.** A few quick questions to find where to start: ${strands.map((s) => s.name).join(", ")}.`);
	for (const s of strands) {
		const a = await showChoice(ctx, {
			title: "Placement · self-report",
			question: `How comfortable are you with ${s.name}?`,
			details: s.description,
			options: SELF_REPORT_OPTIONS.map((o) => ({ label: o.label })),
		});
		if (!a) throw new PlanCancelled();
		s.self_report = a.kind === "options" ? SELF_REPORT_OPTIONS[a.selected[0]!]!.value : "never";
	}

	const toProbe = strands.filter((s) => s.self_report !== "never");
	if (toProbe.length > 0) {
		const { output: ladders } = await runAgent(env, {
			role: "planner",
			prompt: "placement",
			label: "writing placement questions",
			task:
				`Goal: ${goal}\n\nWrite ladders for these strands:\n` +
				toProbe.map((s) => `- ${s.name}: ${s.description} (learner says: ${s.self_report})`).join("\n"),
			output: LaddersSchema,
		});
		for (const l of ladders?.ladders ?? []) {
			const s = toProbe.find((x) => x.name.toLowerCase() === l.strand.toLowerCase());
			if (!s) continue;
			s.ladder = l.rungs
				.filter((r) => checkOk(r.check as Check))
				.map((r, level) => ({ level, covers: r.covers, check: { ...(r.check as ChoiceCheck | NumericCheck), covers: [] } }));
		}
	}

	let budget = rt.config.placement.max_total;
	const probed = toProbe.filter((s) => s.ladder.length > 0);
	for (const [i, s] of probed.entries()) {
		const max = strandBudget(budget, probed.length - i, rt.config.placement.max_per_strand);
		const probe = new LadderProbe(s.ladder.length, startRung(s.ladder.length, s.self_report!)!, max);
		for (let r = probe.next(); r !== undefined; r = probe.next()) {
			const res = await askRung(rt, ctx, s.name, s.asked.length + 1, s.ladder[r]!);
			if (!res) throw new PlanCancelled();
			probe.record(r, res.correct);
			s.asked.push({ rung: r, correct: res.correct, dont_know: res.dontKnow || undefined });
		}
		s.frontier = probe.frontier();
		budget -= probe.questionsAsked();
	}
	for (const s of strands) rt.store.appendEvidence({ kind: "placement", data: { strand: s.name, self_report: s.self_report, frontier: s.frontier, asked: s.asked } });
	const summary = strands
		.map((s) => {
			if (s.self_report === "never") return `- **${s.name}**: starting from the beginning`;
			const at = s.frontier >= 0 ? s.ladder[s.frontier]!.covers : "nothing yet";
			return `- **${s.name}**: solid up to: ${at}`;
		})
		.join("\n");
	rt.note(`**Placement results**\n\n${summary}`);
	return strands;
}

function placementForPlanner(strands: StrandPlacement[]): string {
	if (strands.length === 0) return "(no placement was run)";
	return strands
		.map((s) => {
			const head = `### ${s.name}\n${s.description}\nSelf-report: ${s.self_report ?? "n/a"}`;
			if (s.self_report === "never") return `${head}\nFrontier: below the first rung (teach this strand from the start).`;
			const rungs = s.ladder
				.map((r, i) => {
					const asked = s.asked.find((a) => a.rung === i);
					const mark = asked ? (asked.correct ? "PASSED" : asked.dont_know ? "didn't know" : "FAILED") : i <= s.frontier ? "implied passed" : "implied not known";
					return `- rung ${i}: ${r.covers} [${mark}]`;
				})
				.join("\n");
			return `${head}\n${rungs}`;
		})
		.join("\n\n");
}

async function draftPlan(rt: LearnRuntime, ctx: ExtensionContext, goal: string, brief: string, strands: StrandPlacement[], feedback?: { previous: PlanOut; text: string }): Promise<PlanOut> {
	const existing = rt.store.loadNodes();
	let task =
		`## Goal\n${goal}\n\n## Research brief\n${brief}\n\n## Placement results\n${placementForPlanner(strands)}\n\n` +
		`## Nodes already in the learner's graph (reuse these ids exactly)\n${graphSummary(existing)}\n`;
	if (feedback) {
		task += `\n## Your previous plan\n\`\`\`yaml\n${YAML.stringify(feedback.previous)}\`\`\`\n\n## Revise it\n${feedback.text}\n`;
	}
	const { output } = await runAgent(rt.agentEnv(ctx), {
		role: "planner",
		prompt: "planner",
		label: feedback ? "revising the plan" : "drafting the knowledge graph",
		task,
		output: PlanSchema,
	});
	if (!output) throw new Error("the planner produced no plan");
	return output;
}

/** Ask Jev whether new nodes duplicate existing ones, and reuse the existing id when it's confident. */
async function matchExisting(rt: LearnRuntime, ctx: ExtensionContext, plan: PlanOut): Promise<string[]> {
	const existing = [...rt.store.loadNodes().values()];
	const jev = findJev(ctx.modelRegistry);
	if (!jev || existing.length === 0) return [];
	const renamed: string[] = [];
	const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
	for (const n of plan.nodes.filter((p) => p.status === "new")) {
		const w = words(`${n.title} ${n.id}`);
		const candidates = existing
			.map((e) => ({ e, score: [...words(`${e.title} ${e.id}`)].filter((x) => w.has(x)).length }))
			.filter((c) => c.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 5)
			.map((c) => c.e);
		if (candidates.length === 0) continue;
		const criteria: Record<string, string> = { none: "None of the existing nodes is the same idea" };
		candidates.forEach((c, i) => (criteria[`n${i}`] = `Existing node \`existing[${i}].title\` is the same idea`));
		const r = await ctx.modelRegistry.classify(jev, {
			state: { proposed: { title: n.title, outline: n.outline.map((b) => b.point) }, existing: candidates.map((c) => ({ id: c.id, title: c.title })) },
			questions: {
				same: {
					type: "choice",
					instructions: "Is the proposed node `proposed` the same idea as one of the existing nodes in `existing`, such that teaching it again would be redundant?",
					criteria,
				},
			},
		});
		const a = r.answers.same;
		if (r.stopReason !== "stop" || a?.type !== "choice" || a.choice === "none" || (a.probabilities[a.choice] ?? 0) < 0.75) continue;
		const match = candidates[Number(a.choice.slice(1))];
		if (!match) continue;
		const oldId = n.id;
		n.id = match.id;
		n.status = "reuse";
		for (const other of plan.nodes) other.requires = other.requires.map((r) => (r === oldId ? match.id : r));
		if (plan.goal_node === oldId) plan.goal_node = match.id;
		renamed.push(`${n.title} → existing "${match.title}"`);
	}
	return renamed;
}

/** Write gates for the given plan nodes, in parallel batches. */
export async function writeGates(rt: LearnRuntime, ctx: ExtensionContext, goal: string, brief: string, nodes: PlanNodeOut[], problems?: Map<string, string[]>): Promise<Map<string, Check[]>> {
	const batches: PlanNodeOut[][] = [];
	for (let i = 0; i < nodes.length; i += 5) batches.push(nodes.slice(i, i + 5));
	const results = await Promise.all(
		batches.map((batch, bi) => {
			const desc = batch
				.map((n) => {
					const prob = problems?.get(n.id);
					return (
						`### \`${n.id}\`: ${n.title} (${n.kind})\nOutline:\n${n.outline.map((b, i) => `${i}. ${b.point}`).join("\n")}` +
						(n.lab ? `\nLab: ${n.lab.type}: ${n.lab.spec}` : "") +
						(prob ? `\nYour previous gate had these problems; fix them:\n${prob.map((p) => `- ${p}`).join("\n")}` : "")
					);
				})
				.join("\n\n");
			return runAgent(rt.agentEnv(ctx), {
				role: "gate_writer",
				prompt: "gate-writer",
				label: `writing gates ${batches.length > 1 ? `(${bi + 1}/${batches.length})` : ""}`.trim(),
				task: `## Learning goal\n${goal}\n\n## Research brief (for accuracy)\n${brief.slice(0, 12_000)}\n\n## Nodes needing gates\n\n${desc}`,
				output: GatesSchema,
			});
		}),
	);
	const out = new Map<string, Check[]>();
	for (const r of results) for (const g of r.output?.gates ?? []) out.set(g.node, g.checks as Check[]);
	return out;
}

function toKNode(p: PlanNodeOut, topic: string, existing?: KNode): KNode {
	if (existing) return { ...existing, topics: [...new Set([...existing.topics, topic])] };
	const now = new Date().toISOString();
	return {
		id: p.id,
		title: p.title,
		kind: p.kind,
		requires: p.requires,
		outline: p.status === "placed" ? [] : p.outline,
		state: p.status === "placed" ? "placed" : "locked",
		topics: [topic],
		strand: p.strand,
		lab: p.lab ? { ...p.lab } : undefined,
		created: now,
		updated: now,
	};
}

interface Draft {
	plan: PlanOut;
	nodes: KNode[];
	taught: Set<string>;
	gates: Map<string, Check[]>;
}

function assemble(rt: LearnRuntime, plan: PlanOut, slug: string, gates: Map<string, Check[]>): Draft {
	const existing = rt.store.loadNodes();
	const nodes: KNode[] = [];
	const taught = new Set<string>();
	for (const p of plan.nodes) {
		p.id = p.id.trim().toLowerCase();
		const prior = existing.get(p.id);
		if (p.status === "reuse" && !prior) p.status = "new";
		nodes.push(toKNode(p, slug, p.status === "reuse" ? prior : undefined));
		if (p.status === "new") taught.add(p.id);
	}
	return { plan, nodes, taught, gates };
}

function validateDraft(rt: LearnRuntime, d: Draft) {
	return validatePlan({ nodes: d.nodes, existing: rt.store.loadNodes(), gates: d.gates, taught: d.taught, goal: d.plan.goal_node });
}

function errorsByNode(errors: string[]): { nodeErrors: Map<string, string[]>; graphErrors: string[] } {
	const nodeErrors = new Map<string, string[]>();
	const graphErrors: string[] = [];
	for (const e of errors) {
		const m = /^([a-z0-9/-]+)(?:#[^:]+)?: (.*)$/.exec(e);
		const isGateError = m && /check|gate|option|answer|rubric|tolerance|covers|beat \d+ \(|prompt/.test(m[2]!);
		if (m && isGateError) nodeErrors.set(m[1]!, [...(nodeErrors.get(m[1]!) ?? []), m[2]!]);
		else graphErrors.push(e);
	}
	return { nodeErrors, graphErrors };
}

function planLines(rt: LearnRuntime, d: Draft, slug: string, title: string, goal: string, warnings: string[], theme: { fg(c: string, t: string): string; bold(t: string): string }, width: number): string[] {
	const map = new Map(rt.store.loadNodes());
	for (const n of d.nodes) map.set(n.id, n);
	const sub = new Map(d.nodes.map((n) => [n.id, n]));
	const order = topoSort(sub, d.plan.nodes.map((n) => n.id));
	const topic: Topic = { slug, title, goal, goal_node: d.plan.goal_node, nodes: order, status: "planning", created: "", backlog: [] };
	const out: string[] = [];
	out.push(...wrapLines(theme.fg("text", d.plan.approach), width));
	out.push("");
	out.push(...mapLines(topic, map, theme));
	out.push("");
	if (warnings.length > 0) {
		out.push(theme.fg("warning", "Warnings:"));
		for (const w of warnings) out.push(...wrapLines(theme.fg("warning", `• ${w}`), width, "  "));
		out.push("");
	}
	out.push(theme.bold("Lessons and their gates"));
	for (const id of order) {
		if (!d.taught.has(id)) continue;
		const n = sub.get(id)!;
		out.push("");
		out.push(theme.fg("accent", `■ ${n.title}`) + theme.fg("dim", `  ${n.id} · ${n.kind}`));
		n.outline.forEach((b, i) => out.push(...wrapLines(theme.fg("text", `${i + 1}. ${mathText(b.point)}`), width, "    ")));
		if (n.lab) out.push(...wrapLines(theme.fg("muted", `Lab (${n.lab.type}): ${n.lab.justification}`), width, "    "));
		for (const c of d.gates.get(id) ?? []) out.push(...wrapLines(theme.fg("muted", `Gate ${c.id} (${c.type}): ${mathText(c.prompt)}`), width, "    "));
	}
	return out;
}

async function editGate(rt: LearnRuntime, ctx: ExtensionContext, d: Draft): Promise<void> {
	const ids = [...d.taught];
	const pick = await ctx.ui.select("Edit which node's gate?", ids.map((id) => `${id}: ${d.nodes.find((n) => n.id === id)?.title}`));
	if (!pick) return;
	const id = pick.slice(0, pick.indexOf(":"));
	const node = d.nodes.find((n) => n.id === id)!;
	let text = YAML.stringify(d.gates.get(id) ?? [], { lineWidth: 0 });
	for (;;) {
		const edited = await ctx.ui.editor(`Gate for ${id} (YAML list of checks)`, text);
		if (edited === undefined) return;
		text = edited;
		try {
			const checks = YAML.parse(edited) as Check[];
			const errors = validateChecks(node, checks);
			if (errors.length === 0) {
				d.gates.set(id, checks);
				return;
			}
			ctx.ui.notify(errors.join("\n"), "error");
		} catch (e) {
			ctx.ui.notify(`Invalid YAML: ${(e as Error).message}`, "error");
		}
	}
}

// ── The whole flow ────────────────────────────────────────────────────────────

export async function planTopic(rt: LearnRuntime, ctx: ExtensionCommandContext, request: string): Promise<void> {
	try {
		await runPlanning(rt, ctx, request);
	} catch (e) {
		if (e instanceof PlanCancelled) {
			rt.note("Planning cancelled. Nothing was saved.");
			return;
		}
		const msg = e instanceof AgentError ? `${e.run.role} failed: ${e.message}` : (e as Error).message;
		rt.note(`Planning stopped: ${msg}`, "error");
	}
}

async function runPlanning(rt: LearnRuntime, ctx: ExtensionCommandContext, request: string): Promise<void> {
	rt.note(`**Planning:** "${request}". Each step runs as a subagent; you'll see them above the editor.`);
	const goal = await interview(rt, ctx, request);
	rt.note(`**Goal:** ${goal.goal}`);

	const brief = await research(rt, ctx, goal.goal);
	const topicDir = rt.store.topicDir(goal.slug);
	fs.mkdirSync(topicDir, { recursive: true });
	fs.writeFileSync(path.join(topicDir, "research.md"), `# Research brief: ${goal.title}\n\n${brief}\n`, "utf8");
	rt.note(`Research brief saved to \`${path.relative(rt.cwd, path.join(topicDir, "research.md"))}\`.`);

	const strands = await placement(rt, ctx, goal.goal, brief);

	let plan = await draftPlan(rt, ctx, goal.goal, brief, strands);
	const renamed = await matchExisting(rt, ctx, plan).catch(() => []);
	if (renamed.length > 0) rt.note(`Reusing nodes you already have: ${renamed.join("; ")}.`);
	let draft = assemble(rt, plan, goal.slug, new Map());
	draft.gates = await writeGates(rt, ctx, goal.goal, brief, plan.nodes.filter((n) => draft.taught.has(n.id)));

	for (;;) {
		// Repair loop: graph problems go back to the planner, gate problems to the gate writer.
		let result = validateDraft(rt, draft);
		for (let round = 0; round < 2 && result.errors.length > 0; round++) {
			const { nodeErrors, graphErrors } = errorsByNode(result.errors);
			if (graphErrors.length > 0) {
				plan = await draftPlan(rt, ctx, goal.goal, brief, strands, { previous: plan, text: `Fix these problems:\n${graphErrors.map((e) => `- ${e}`).join("\n")}` });
				const keep = draft.gates;
				draft = assemble(rt, plan, goal.slug, new Map([...keep].filter(([id]) => plan.nodes.some((n) => n.id === id))));
				const missing = plan.nodes.filter((n) => draft.taught.has(n.id) && !draft.gates.has(n.id));
				if (missing.length > 0) for (const [k, v] of await writeGates(rt, ctx, goal.goal, brief, missing)) draft.gates.set(k, v);
			}
			if (nodeErrors.size > 0) {
				const redo = plan.nodes.filter((n) => nodeErrors.has(n.id) && draft.taught.has(n.id));
				for (const [k, v] of await writeGates(rt, ctx, goal.goal, brief, redo, nodeErrors)) draft.gates.set(k, v);
			}
			result = validateDraft(rt, draft);
		}

		if (result.errors.length > 0) {
			rt.note(`The plan still has problems:\n${result.errors.map((e) => `- ${e}`).join("\n")}`, "warning");
		}
		await showPager(ctx, `Plan: ${goal.title}`, (w) => planLines(rt, draft, goal.slug, goal.title, goal.goal, result.warnings, ctx.ui.theme, w));
		const options = result.errors.length > 0 ? ["Request changes", "Edit a gate", "View plan again", "Cancel"] : ["Approve and start", "Request changes", "Edit a gate", "View plan again", "Cancel"];
		const pick = await ctx.ui.select("Plan review", options);
		if (pick === "Approve and start") break;
		if (pick === "View plan again") continue;
		if (pick === "Edit a gate") {
			await editGate(rt, ctx, draft);
			continue;
		}
		if (pick === "Request changes") {
			const fb = await ctx.ui.editor("What should change? (scope, order, a node, a gate…)", "");
			if (!fb?.trim()) continue;
			const before = new Map(plan.nodes.map((n) => [n.id, JSON.stringify(n.outline)]));
			plan = await draftPlan(rt, ctx, goal.goal, brief, strands, { previous: plan, text: fb });
			const keep = new Map([...draft.gates].filter(([id]) => before.get(id) === JSON.stringify(plan.nodes.find((n) => n.id === id)?.outline)));
			draft = assemble(rt, plan, goal.slug, keep);
			const regen = plan.nodes.filter((n) => draft.taught.has(n.id) && !keep.has(n.id));
			const gateFeedback = /gate|question|check|quiz/i.test(fb) ? plan.nodes.filter((n) => draft.taught.has(n.id) && keep.has(n.id)) : [];
			const targets = [...regen, ...gateFeedback];
			if (targets.length > 0) {
				const extra = new Map(gateFeedback.map((n) => [n.id, [`Learner feedback: ${fb}`]]));
				for (const [k, v] of await writeGates(rt, ctx, goal.goal, brief, targets, extra)) draft.gates.set(k, v);
			}
			continue;
		}
		throw new PlanCancelled();
	}

	await freeze(rt, ctx, goal, draft, strands, path.relative(rt.cwd, path.join(topicDir, "research.md")));
}

async function freeze(rt: LearnRuntime, ctx: ExtensionCommandContext, goal: Static<typeof GoalSchema>, d: Draft, strands: StrandPlacement[], researchPath: string): Promise<void> {
	const store = rt.store;
	const all = store.loadNodes();
	for (const n of d.nodes) all.set(n.id, n);
	const titles = new Map([...all.values()].map((n) => [n.id, n.title]));
	for (const n of d.nodes) store.saveNode(n, titles);
	for (const id of d.taught) {
		// Code checks point at fixed lab paths so the frozen gate never needs editing later.
		const checks = d.gates.get(id)!.map((c) =>
			c.type === "code" ? { ...c, solution_file: `labs/${id}/solution.py`, test_file: `.learn/labs/${id}/test_solution.py` } : c,
		);
		if (!store.getGate(id)) store.freezeGate(id, checks);
	}
	const inTopic = closure(all, d.plan.goal_node);
	const order = topoSort(new Map([...all].filter(([id]) => inTopic.has(id))), d.plan.nodes.map((n) => n.id));
	const topic: Topic = {
		slug: goal.slug,
		title: goal.title,
		goal: goal.goal,
		goal_node: d.plan.goal_node,
		nodes: order,
		status: "active",
		created: new Date().toISOString(),
		research: researchPath,
		placement: strands,
		backlog: [],
	};
	store.saveTopic(topic);
	rt.setActiveTopic(topic.slug);
	const nodes = rt.recompute();

	// Skill labs are built now so their code checks can be verified before any lesson.
	const skillLabs = d.nodes.filter((n) => d.taught.has(n.id) && n.lab?.type === "skill");
	if (skillLabs.length > 0) {
		const { buildLab } = await import("../labs/build.ts");
		for (const n of skillLabs) await buildLab(rt, ctx, nodes.get(n.id)!).catch((e) => rt.note(`Lab for "${n.title}" failed: ${(e as Error).message}`, "warning"));
	}

	const { refreshTopicFiles } = await import("./lesson.ts");
	refreshTopicFiles(rt, topic);
	refreshProgressWidget(rt, ctx);
	const taughtCount = order.filter((id) => d.taught.has(id)).length;
	const placed = order.filter((id) => all.get(id)?.state === "placed").length;
	const depth = Math.max(0, ...depths(new Map(order.map((id) => [id, all.get(id)!]))).values());
	rt.note(
		`**Plan frozen.** ${taughtCount} lessons (${placed} foundations already known, ${depth + 1} levels deep). ` +
			`Map: \`maps/${topic.slug}.md\` (or /map). Notes accumulate in \`${path.relative(rt.cwd, store.paths.knowledge)}/\`.\n\n` +
			"Already know a lesson's material? Run /gate before it starts to test out.",
		"success",
	);
	const first = order.map((id) => nodes.get(id)!).find((n) => n.state === "ready");
	if (!first) return;
	const go = await ctx.ui.select(`First lesson: ${first.title}`, ["Start now", "Later"]);
	if (go === "Start now") await startLesson(rt, ctx, store.getTopic(topic.slug)!, first);
}

/** Reuse for split: validate ids and normalise new nodes. */
export function isValidNewNode(p: PlanNodeOut): boolean {
	return NODE_ID_PATTERN.test(p.id) && p.outline.length > 0 && p.outline.length <= 5;
}
