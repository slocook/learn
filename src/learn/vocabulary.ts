import type { ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findJev } from "../gate/free-grader.ts";
import type { KNode } from "../types.ts";
import { LESSON_START } from "./lesson.ts";

export type TermStatus = "explained" | "prerequisite" | "everyday" | "not_yet";

export interface TermClaim {
	term: string;
	status: TermStatus;
}

type BranchEntry = { type: string; customType?: string; details?: any; message?: any };

function textOf(c: unknown): string {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((p: any) => p.type === "text")
		.map((p: any) => p.text)
		.join("\n");
}

/** Everything said in every lesson session for this node, including ones before a resume. */
export function nodeTranscript(branch: BranchEntry[], nodeId: string): string {
	const lines: string[] = [];
	let on = false;
	for (const e of branch) {
		const m = e.message;
		if (e.type === "custom_message" && e.customType === LESSON_START) on = e.details?.node === nodeId;
		else if (m?.role === "custom" && m.customType === LESSON_START) on = m.details?.node === nodeId;
		else if (on && e.type === "message" && (m?.role === "user" || m?.role === "assistant")) {
			const t = textOf(m.content).trim();
			if (t) lines.push(`${m.role === "user" ? "LEARNER" : "TEACHER"}: ${t}`);
		}
	}
	const joined = lines.join("\n\n");
	return joined.length > 60_000 ? `…${joined.slice(-60_000)}` : joined;
}

/**
 * Check the teacher's claims about the gate's vocabulary: "explained" against the lesson transcript,
 * "prerequisite" against the prerequisite nodes. Returns the terms the learner still needs explained.
 * Without Jev the claims are trusted.
 */
export async function unexplainedTerms(ctx: ExtensionContext, claims: TermClaim[], transcript: string, prerequisites: KNode[]): Promise<string[]> {
	const missing = claims.filter((c) => c.status === "not_yet").map((c) => c.term);
	const toCheck = claims.filter((c) => c.status === "explained" || c.status === "prerequisite");
	const jev = findJev(ctx.modelRegistry);
	if (!jev || toCheck.length === 0) return missing;
	const questions: Record<string, ClassifierQuestion> = {};
	toCheck.forEach((c, i) => {
		questions[`t${i}`] =
			c.status === "explained"
				? {
						type: "bool",
						instructions: `In \`lesson_transcript\`, did the teacher explain what "${c.term}" means, in plain words or with a picture or example, so a learner meeting it for the first time would know what it refers to? Only using the term, or stating it in formal notation without saying what it means, doesn't count.`,
						criteria: { true: "The teacher explained it", false: "It was only used, or never appeared" },
					}
				: {
						type: "bool",
						instructions: `Is "${c.term}" one of the ideas taught in \`prerequisites\` (their titles and outline points), so the learner would already know what it means?`,
						criteria: { true: "A prerequisite teaches it", false: "No prerequisite covers it" },
					};
	});
	try {
		const r = await ctx.modelRegistry.classify(jev, {
			state: { lesson_transcript: transcript, prerequisites: prerequisites.map((n) => ({ title: n.title, outline: n.outline.map((b) => b.point) })) },
			questions,
		});
		if (r.stopReason !== "stop") return missing;
		toCheck.forEach((c, i) => {
			const a = r.answers[`t${i}`];
			if (a?.type === "bool" && a.probability < 0.5) missing.push(c.term);
		});
	} catch {
		// A failed check shouldn't block the gate.
	}
	return missing;
}
