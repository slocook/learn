import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findJev } from "../gate/free-grader.ts";
import { LESSON_START } from "./lesson.ts";

export interface ExchangeTurn {
	who: "teacher" | "learner" | "quiz";
	text: string;
}

type BranchEntry = { type: string; customType?: string; message?: any };

function textOf(c: unknown): string {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((p: any) => p.type === "text")
		.map((p: any) => p.text)
		.join("\n");
}

/** The lesson since the last accepted beat_done (or the lesson start): what the current beat was taught with. */
export function beatExchange(branch: BranchEntry[]): ExchangeTurn[] {
	let start = 0;
	branch.forEach((e, i) => {
		const m = e.message;
		if (e.type === "custom_message" && e.customType === LESSON_START) start = i;
		else if (m?.role === "custom" && m.customType === LESSON_START) start = i;
		else if (m?.role === "toolResult" && m.toolName === "beat_done" && !m.isError) start = i;
	});
	const out: ExchangeTurn[] = [];
	for (const e of branch.slice(start + 1)) {
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		const text = textOf(m.content).trim();
		if (!text) continue;
		if (m.role === "user") out.push({ who: "learner", text });
		else if (m.role === "assistant") out.push({ who: "teacher", text });
		else if (m.role === "toolResult" && m.toolName === "quiz") out.push({ who: "quiz", text });
	}
	return out;
}

/**
 * Did the learner do something with the current beat (answer, attempt, explain back), or ask to move
 * on? Undefined when it can't be judged; callers let the beat through then, since this is a guard.
 */
export async function learnerEngaged(ctx: ExtensionContext, point: string, exchange: ExchangeTurn[]): Promise<boolean | undefined> {
	if (!exchange.some((t) => t.who === "learner" || t.who === "quiz")) return false;
	const jev = findJev(ctx.modelRegistry);
	if (!jev) return undefined;
	// Teacher turns give the learner's replies their meaning; keep them short so the learner's words dominate.
	const turns = exchange.slice(-12).map((t) => ({ from: t.who, text: t.who === "teacher" && t.text.length > 1500 ? `…${t.text.slice(-1500)}` : t.text }));
	try {
		const r = await ctx.modelRegistry.classify(jev, {
			state: { point, exchange: turns },
			questions: {
				engaged: {
					type: "bool",
					instructions:
						"In `exchange`, did the learner actively work with `point`: answer a question about it, attempt or take a step, compute, predict, or explain it in their own words? " +
						"Replies that only acknowledge or agree (\"makes sense\", \"sure\", \"got it\", \"yeah, I see it\") do not count, however enthusiastic. A wrong attempt counts as working with it.",
					criteria: { true: "The learner did something with the point", false: "The learner only listened and acknowledged" },
				},
				skip: {
					type: "bool",
					instructions: "In `exchange`, did the learner ask to move on or skip ahead, or say they already know `point`?",
					criteria: { true: "The learner asked to move on or said they know it", false: "No such request" },
				},
			},
		});
		if (r.stopReason !== "stop") return undefined;
		const yes = (q: string) => {
			const a = r.answers[q];
			return a?.type === "bool" && a.probability >= 0.5;
		};
		return yes("engaged") || yes("skip");
	} catch {
		return undefined;
	}
}
