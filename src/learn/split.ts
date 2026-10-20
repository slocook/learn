import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "../agents/runner.ts";
import { SplitSchema } from "../agents/schemas.ts";
import { transition } from "../graph/state.ts";
import { validatePlan } from "../graph/validate.ts";
import type { KNode, Topic } from "../types.ts";
import { showPager } from "../ui/pager.ts";
import { wrapLines } from "../ui/text.ts";
import { refreshTopicFiles, startLesson } from "./lesson.ts";
import { isValidNewNode, writeGates } from "./planning.ts";
import type { GateRunState, LearnRuntime } from "./runtime.ts";
import { refreshProgressWidget } from "./widgets.ts";

/**
 * Find the missing foundation under a node the learner keeps failing, add it as new
 * prerequisite node(s) with their own frozen gates, and teach those first. The original
 * node's gate is untouched.
 */
export async function splitNode(rt: LearnRuntime, ctx: ExtensionContext, topic: Topic, node: KNode, failed: GateRunState["results"]): Promise<void> {
	const store = rt.store;
	const gate = store.getGate(node.id);
	const existing = store.loadNodes();
	const failures = failed
		.map((f) => {
			const c = gate?.checks.find((x) => x.id === f.checkId);
			return `- ${c?.prompt ?? f.checkId}\n  Missed: ${f.missed?.join("; ") || f.detail}\n  Answer: ${f.answer ?? "(n/a)"}`;
		})
		.join("\n");
	const prereqs = node.requires.map((r) => `- \`${r}\`: ${existing.get(r)?.title ?? r}`).join("\n") || "(none)";
	let out;
	try {
		({ output: out } = await runAgent(rt.agentEnv(ctx), {
			role: "planner",
			prompt: "splitter",
			label: `finding what's under "${node.title}"`,
			task:
				`## Node\n${node.title} (\`${node.id}\`)\nOutline:\n${node.outline.map((b, i) => `${i + 1}. ${b.point}`).join("\n")}\n\n` +
				`## Its prerequisites\n${prereqs}\n\n## Gate checks the learner kept failing\n${failures}\n\n` +
				`## All existing node ids (requires may only use these or your new ids)\n${[...existing.keys()].join(", ")}`,
			output: SplitSchema,
		}));
	} catch (e) {
		rt.note(`Couldn't split the node: ${(e as Error).message}`, "error");
		return;
	}
	const proposed = (out?.nodes ?? []).filter((p) => isValidNewNode(p) && !existing.has(p.id));
	if (proposed.length === 0) {
		rt.note("The splitter found nothing new underneath. Staying on this node; /pass closes it if you decide it's done.", "warning");
		return;
	}
	const gates = await writeGates(rt, ctx, topic.goal, "", proposed);
	const now = new Date().toISOString();
	const newNodes: KNode[] = proposed.map((p) => ({
		id: p.id,
		title: p.title,
		kind: p.kind,
		requires: p.requires.filter((r) => existing.has(r) || proposed.some((q) => q.id === r)),
		outline: p.outline,
		state: "locked",
		topics: [topic.slug],
		created: now,
		updated: now,
	}));
	const { errors } = validatePlan({ nodes: newNodes, existing, gates, taught: new Set(newNodes.map((n) => n.id)) });
	if (errors.length > 0) {
		rt.note(`The proposed split has problems, so nothing changed:\n${errors.map((e) => `- ${e}`).join("\n")}`, "warning");
		return;
	}

	await showPager(ctx, "Proposed split", (w) => {
		const t = ctx.ui.theme;
		const lines = [...wrapLines(t.fg("text", out!.reason), w), ""];
		for (const n of newNodes) {
			lines.push(t.fg("accent", `■ ${n.title}`) + t.fg("dim", `  ${n.id}`));
			n.outline.forEach((b, i) => lines.push(...wrapLines(`${i + 1}. ${b.point}`, w, "    ")));
			for (const c of gates.get(n.id) ?? []) lines.push(...wrapLines(t.fg("muted", `Gate ${c.id} (${c.type}): ${c.prompt}`), w, "    "));
			lines.push("");
		}
		lines.push(t.fg("muted", `These come before "${node.title}", whose gate stays the same.`));
		return lines;
	});
	const ok = await ctx.ui.confirm("Add these and learn them first?", `${newNodes.length} new node(s) before "${node.title}".`);
	if (!ok) {
		rt.note("Split declined. Staying on this node.");
		return;
	}

	const titles = rt.titles(new Map([...existing, ...newNodes.map((n) => [n.id, n] as const)]));
	for (const n of newNodes) {
		store.saveNode(n, titles);
		store.freezeGate(n.id, gates.get(n.id)!);
	}
	const current = store.getNode(node.id)!;
	current.requires = [...new Set([...current.requires, ...newNodes.map((n) => n.id)])];
	current.state = transition(current.state, "split");
	store.saveNode(current, titles);
	store.appendEvidence({ kind: "state", node: node.id, topic: topic.slug, data: { event: "split", added: newNodes.map((n) => n.id) } });

	const fresh = store.getTopic(topic.slug)!;
	const at = fresh.nodes.indexOf(node.id);
	fresh.nodes.splice(at < 0 ? fresh.nodes.length : at, 0, ...newNodes.map((n) => n.id));
	fresh.lesson = undefined;
	store.saveTopic(fresh);
	const nodes = rt.recompute();
	refreshTopicFiles(rt, fresh);
	refreshProgressWidget(rt, ctx);
	const first = newNodes.map((n) => nodes.get(n.id)!).find((n) => n.state === "ready");
	if (first) await startLesson(rt, ctx, store.getTopic(topic.slug)!, first);
}
