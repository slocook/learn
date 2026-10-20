import type { SelfReport } from "../types.ts";

/** Where the binary search starts on a ladder of `length` rungs, given the learner's self-report. */
export function startRung(length: number, report: SelfReport): number | undefined {
	if (length === 0 || report === "never") return undefined;
	const fraction = { heard: 0.25, use: 0.5, derive: 0.75 }[report];
	return Math.min(length - 1, Math.floor(length * fraction));
}

/**
 * Binary search for the highest rung the learner can pass. `lo` is the highest rung known passed
 * (-1 = none), `hi` the lowest known failed (`length` = none). A correct answer jumps up; a miss or
 * "I don't know" comes back down. Code, not a model, picks every question and when to stop.
 */
export class LadderProbe {
	readonly length: number;
	private readonly start: number;
	private readonly maxQuestions: number;
	private lo = -1;
	private hi: number;
	private readonly asked: number[] = [];

	constructor(length: number, start: number, maxQuestions: number) {
		this.length = length;
		this.start = start;
		this.maxQuestions = maxQuestions;
		this.hi = length;
	}

	next(): number | undefined {
		if (this.asked.length >= this.maxQuestions || this.hi - this.lo <= 1) return undefined;
		if (this.asked.length === 0) return this.start;
		return Math.floor((this.lo + this.hi + 1) / 2);
	}

	record(rung: number, correct: boolean): void {
		this.asked.push(rung);
		if (correct) this.lo = Math.max(this.lo, rung);
		else this.hi = Math.min(this.hi, rung);
	}

	/** Highest rung passed, or -1. */
	frontier(): number {
		return this.lo;
	}

	questionsAsked(): number {
		return this.asked.length;
	}
}

/** Split a total question budget across strands, at most `perStrand` each. */
export function strandBudget(totalLeft: number, strandsLeft: number, perStrand: number): number {
	if (strandsLeft <= 0) return 0;
	return Math.max(1, Math.min(perStrand, Math.floor(totalLeft / strandsLeft)));
}
