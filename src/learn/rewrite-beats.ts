import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "../agents/runner.ts";
import { BeatRewriteSchema } from "../agents/schemas.ts";
import { isSatisfied } from "../graph/graph.ts";
import type { KNode, Topic } from "../types.ts";
import { showPager } from "../ui/pager.ts";
import { mathText, wrapLines } from "../ui/text.ts";
import { type BeatRef, type BeatVerdict, beatProblem, checkBeats, isBorderline, isFlagged } from "./beat-check.ts";
import type { LearnRuntime } from "./runtime.ts";

/** Beats still ahead of the learner: untaught nodes, and the current node's unfinished beats. */
export function remainingBeats(topic: Topic, nodes: Map<string, KNode>): BeatRef[] {
	const out: BeatRef[] = [];
	for (const id of topic.nodes) {
		const n = nodes.get(id);
		if (!n || n.state === "placed" || isSatisfied(n.state)) continue;
		const done = topic.lesson?.node === id ? topic.lesson.beats_done : [];
		n.outline.forEach((b, index) => {
			if (!done.includes(index)) out.push({ node: id, title: n.title, index, point: b.point });
		});
	}
	return out;
}

function rewriteTask(rt: LearnRuntime, flagged: BeatVerdict[], nodes: Map<string, KNode>): string {
	const byNode = new Map<string, BeatVerdict[]>();
	for (const v of flagged) byNode.set(v.node, [...(byNode.get(v.node) ?? []), v]);
	return [...byNode]
		.map(([id, vs]) => {
			const n = nodes.get(id)!;
			const gate = rt.store.getGate(id);
			const checks = (gate?.checks ?? []).map((c) => `- ${c.id} (tests beats ${c.covers.map((i) => i + 1).join(", ")}): ${c.prompt}`);
			return [
				`### \`${id}\`: ${n.title}`,
				"Outline:",
				...n.outline.map((b, i) => `${i + 1}. ${b.point}`),
				"Gate checks:",
				...checks,
				"Rewrite:",
				...vs.map((v) => `- ${beatProblem(v)}`),
			].join("\n");
		})
		.join("\n\n");
}

/**
 * Check a topic's remaining beats with Jev, have the flagged ones rewritten, show the changes, and save
 * them if the learner approves. Gates stay frozen: each beat keeps its index, so their coverage holds.
 */
export async function reviewTopicBeats(rt: LearnRuntime, ctx: ExtensionContext, topic: Topic): Promise<void> {
	const nodes = rt.store.loadNodes();
	const beats = remainingBeats(topic, nodes);
	if (beats.length === 0) return ctx.ui.notify("No beats left to check in this topic.", "info");

	ctx.ui.setStatus("learn-beats", `Checking ${beats.length} beats…`);
	let verdicts: BeatVerdict[] | undefined;
	try {
		verdicts = await checkBeats(ctx.modelRegistry, beats);
	} finally {
		ctx.ui.setStatus("learn-beats", undefined);
	}
	if (!verdicts) return ctx.ui.notify("Checking beats needs Jev (typesafe/jev-latest), which isn't available.", "warning");
	if (verdicts.length === 0) return ctx.ui.notify("Couldn't reach Jev to check the beats. Nothing was changed.", "warning");
	const flagged = verdicts.filter(isFlagged);
	const borderline = verdicts.filter(isBorderline).length;
	if (flagged.length === 0) {
		return rt.note(`All ${verdicts.length} remaining beats read as single general ideas${borderline ? ` (${borderline} borderline)` : ""}.`);
	}

	const { output } = await runAgent(rt.agentEnv(ctx), {
		role: "planner",
		prompt: "beat-rewriter",
		label: `rewriting ${flagged.length} beats`,
		task: rewriteTask(rt, flagged, nodes),
		output: BeatRewriteSchema,
	});
	const wanted = new Set(flagged.map((v) => `${v.node}#${v.index}`));
	const rewrites = (output?.beats ?? [])
		.map((b) => ({ ...b, index: b.index - 1 }))
		.filter((b) => wanted.has(`${b.node}#${b.index}`) && nodes.get(b.node)?.outline[b.index]);
	if (rewrites.length === 0) return rt.note("The rewriter returned nothing usable. No beats were changed.", "warning");

	// One re-check, so the review shows which rewrites still miss.
	const after = new Map(
		((await checkBeats(ctx.modelRegistry, rewrites.map((r) => ({ node: r.node, title: nodes.get(r.node)!.title, index: r.index, point: r.point })))) ?? []).map((v) => [
			`${v.node}#${v.index}`,
			v,
		]),
	);
	const reason = new Map(flagged.map((v) => [`${v.node}#${v.index}`, v.kind]));

	await showPager(ctx, `Beat rewrites: ${topic.title}`, (w) => {
		const t = ctx.ui.theme;
		const out = wrapLines(
			t.fg("muted", `${verdicts.length} beats checked: ${flagged.length} flagged, ${borderline} borderline. Gates are unchanged; each beat keeps its position.`),
			w,
		);
		let last = "";
		for (const r of rewrites) {
			if (r.node !== last) {
				out.push("", t.fg("accent", `■ ${nodes.get(r.node)!.title}`) + t.fg("dim", `  ${r.node}`));
				last = r.node;
			}
			const key = `${r.node}#${r.index}`;
			const still = after.get(key);
			out.push(...wrapLines(t.fg("dim", `${r.index + 1}. [${reason.get(key)}] ${mathText(nodes.get(r.node)!.outline[r.index]!.point)}`), w, "  "));
			out.push(...wrapLines(t.fg("text", `→ ${mathText(r.point)}`), w, "     "));
			if (still && isFlagged(still)) out.push(...wrapLines(t.fg("warning", `still reads as: ${still.kind}`), w, "     "));
		}
		return out;
	});

	const pick = await ctx.ui.select(`Apply ${rewrites.length} rewritten beats?`, ["Apply", "Cancel"]);
	if (pick !== "Apply") return rt.note("Beat rewrites discarded. Nothing was changed.");
	const changed = new Set<string>();
	for (const r of rewrites) {
		const n = nodes.get(r.node)!;
		const before = n.outline[r.index]!;
		n.outline[r.index] = { point: r.point, motivation: r.motivation };
		changed.add(n.id);
		rt.store.appendEvidence({ kind: "outline_rewrite", node: n.id, topic: topic.slug, data: { beat: r.index + 1, before: before.point, after: r.point } });
	}
	const titles = rt.titles();
	for (const id of changed) {
		const n = nodes.get(id)!;
		n.updated = new Date().toISOString();
		rt.store.saveNode(n, titles);
	}
	rt.note(`Rewrote ${rewrites.length} beats in ${changed.size} nodes. Gates are unchanged.`, "success");
}
