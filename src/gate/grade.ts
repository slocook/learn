import type { ChoiceCheck, FreeCheck, NumericCheck } from "../types.ts";
import { parseNumericAnswer } from "./numeric.ts";

export function choiceAnswers(check: ChoiceCheck): string[] {
	return Array.isArray(check.answer) ? check.answer : [check.answer];
}

/** Exact-set match. "I don't know" is never correct; callers record it separately. */
export function gradeChoice(check: ChoiceCheck, selected: string[]): boolean {
	const want = new Set(choiceAnswers(check));
	const got = new Set(selected);
	return want.size === got.size && [...want].every((v) => got.has(v));
}

export interface NumericGrade {
	correct: boolean;
	value?: number;
	/** Set when the input couldn't be read at all; the learner should retype it, nothing is graded. */
	error?: string;
	/** Set when the input was a definite answer of the wrong shape (e.g. a vector); graded as wrong. */
	note?: string;
}

/** Split on commas that are not inside parentheses, e.g. "(6, atan2(1, 2))" → ["6", "atan2(1, 2)"]. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		else if (ch === "," && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.map((p) => p.trim());
}

/** True when the input is a list of numbers, like "(6, -4)" or "[1, 2, 3]". */
function isNumberList(input: string): boolean {
	const inner = input.trim().replace(/^[([](.*)[)\]]$/s, "$1");
	const parts = splitTopLevel(inner);
	if (parts.length < 2) return false;
	return parts.every((p) => {
		try {
			return Number.isFinite(parseNumericAnswer(p));
		} catch {
			return false;
		}
	});
}

export function gradeNumeric(check: NumericCheck, input: string): NumericGrade {
	let value: number;
	try {
		value = parseNumericAnswer(input, check.unit);
	} catch {
		// A vector or list is a real answer, just the wrong kind: grade it rather than bounce it.
		if (isNumberList(input)) return { correct: false, note: "the answer is a single number, not a list or vector" };
		return {
			correct: false,
			error: `Couldn't read "${input}". Type one number or expression, e.g. 2, -0.5, pi/6, 2*sqrt(3), atan2(1, 2).`,
		};
	}
	const diff = Math.abs(value - check.answer);
	const allowed = check.relative ? Math.abs(check.answer) * check.tolerance : check.tolerance;
	// A small floor keeps "exact" answers like 0.5 from failing on floating-point noise.
	return { correct: diff <= Math.max(allowed, 1e-9 * Math.max(1, Math.abs(check.answer))), value };
}

export type IdeaStatus = "present" | "missing" | "contradicted" | "unclear";

export interface IdeaJudgment {
	/** Index into the check's rubric. */
	index: number;
	status: IdeaStatus;
	note?: string;
}

export interface FreeVerdict {
	outcome: "pass" | "fail" | "follow_up";
	judgments: IdeaJudgment[];
	/** Ideas the answer lacked or got wrong, in rubric wording, for feedback and the teacher. */
	missed: string[];
	followUp?: string;
}

/**
 * Turn per-idea judgments into a verdict. An idea fails only when it is missing or contradicted.
 * Unclear ideas earn one clarifying follow-up; after that, the learner gets the benefit of the doubt.
 */
export function combineFreeVerdict(
	check: FreeCheck,
	judgments: IdeaJudgment[],
	followUpUsed: boolean,
	followUp?: string,
): FreeVerdict {
	const byIndex = new Map(judgments.map((j) => [j.index, j]));
	const complete = check.rubric.map((_, i) => byIndex.get(i) ?? { index: i, status: "unclear" as const });
	const missed = complete
		.filter((j) => j.status === "missing" || j.status === "contradicted")
		.map((j) => check.rubric[j.index]!.idea);
	if (missed.length > 0) return { outcome: "fail", judgments: complete, missed };
	const unclear = complete.filter((j) => j.status === "unclear");
	if (unclear.length > 0 && !followUpUsed) {
		// The fallback must not hint at the missing idea; the grader's own follow-up usually replaces it.
		const fallback = "Could you expand on your answer a little? Say what you mean in a sentence or two more.";
		return { outcome: "follow_up", judgments: complete, missed: [], followUp: followUp?.trim() || fallback };
	}
	return { outcome: "pass", judgments: complete, missed: [] };
}

/** Map a Jev probability that an idea is expressed to a status. */
export function statusFromProbability(present: number, contradicted?: number): IdeaStatus {
	if (contradicted !== undefined && contradicted >= 0.6) return "contradicted";
	if (present >= 0.6) return "present";
	if (present <= 0.3) return "missing";
	return "unclear";
}
