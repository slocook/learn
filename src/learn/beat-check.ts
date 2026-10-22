import type { ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { findJev } from "../gate/free-grader.ts";

export type BeatKind = "idea" | "result" | "exercise" | "several" | "procedure";

export interface BeatRef {
	node: string;
	title: string;
	index: number;
	point: string;
}

export interface BeatVerdict extends BeatRef {
	kind: BeatKind;
	/** Probability that the beat is a plain idea. */
	idea: number;
}

/** Below this, an "idea" verdict is shown as a warning in plan review. */
export const BORDERLINE_IDEA = 0.6;

// Examples are deliberately outside any one subject, so the check isn't tuned to the plans it judges.
// Jev accepts structured instructions and criteria (objects with definitions, contrasts and examples);
// pi's types only declare strings, but the request passes them through unchanged.
const KIND_QUESTION = {
	type: "choice",
	instructions: {
		question: "Which best describes `beat`?",
		context:
			"A beat is one step of a lesson outline, taught in a few short exchanges. The teacher picks examples while teaching, and a separate gate later tests the learner on its own case. " +
			"A good beat is a claim the learner should end up believing, stated generally, and is one realisation that can be said in a sentence or two.",
		note: "Verbs like 'Derive', 'Explain' or 'Show' are fine. Judge the content, not the wording.",
	},
	criteria: {
		idea: {
			what: "One general claim, definition or relationship that the learner can come to see. It may include its conditions, an exception, or a contrast with a common mistake. A short formula that is itself the relationship counts, as does how to set up a problem or what an algorithm step does and why.",
			not_for:
				"Beats that hand over a long derived closed form (result), fix particular numbers or a case to work (exercise), bundle independent points (several), or give coding or reporting advice (procedure).",
			examples: [
				"Explain why variances of independent variables add but standard deviations do not.",
				"Use the chain rule to show that the rate of change of a composite is the product of the rates, F'(x) = f'(g(x)) g'(x).",
				"Model a cooling object by making its rate of temperature change proportional to the difference from room temperature.",
			],
		},
		result: {
			what: "The beat writes out a derived closed form that the learner should work out themselves: a matrix of entries, a series or full expansion, an explicit determinant or solution expression. Teaching it hands over the conclusion.",
			not_for: "A short formula that simply states the relationship being taught (idea).",
			examples: ["Differentiate to obtain the Hessian [[2y, 2x + 3], [2x + 3, -6z]].", "Show that the small-angle pendulum solution is θ(t) = θ₀ cos(√(g/L) t) with period 2π√(L/g)."],
		},
		exercise: {
			what: "A specific worked example or problem: particular numbers, a concrete instance to compute, a small example to work through, or its answers.",
			not_for: "A general claim that mentions a kind of situation without working a case (idea).",
			examples: [
				"For two fair dice, compute the variance of the sum to get 35/6.",
				"Work a small 2×2 example and check it numerically.",
				"Work a small example of compound interest and explain why adding the rates each year is not the same thing.",
			],
		},
		several: {
			what: "Two or more independent realisations in one step: each part would need its own explanation and its own question, so the whole can't be said in a sentence or two.",
			not_for: "One idea together with its conditions, an exception, or a contrast (idea).",
			examples: [
				"Define conditional probability, derive Bayes' rule, and explain the base-rate fallacy.",
				"Explain why the ratio test is inconclusive at 1, how the root test compares, and when to use a comparison test instead.",
			],
		},
		procedure: {
			what: "Coding, numerical hygiene, or how to log or report a computation: advice about carrying out the work rather than an idea about the subject.",
			not_for: "How to formulate a problem or what an algorithm step does and why (idea).",
			examples: ["Store angles in radians and wrap them after each update.", "Log the residual and iteration count separately.", "Call a linear solver instead of forming the inverse."],
		},
	},
} as unknown as ClassifierQuestion;

const PROBLEM: Record<Exclude<BeatKind, "idea">, string> = {
	result: "writes out a derived closed form the learner should work out; state the relationship and leave the result to the lesson",
	exercise: "is a specific exercise or worked example; state the general idea it illustrates and leave cases to the teacher and the gate",
	several: "bundles several separate ideas; keep it to one realisation",
	procedure: "is coding or reporting advice rather than an idea; fold it into a beat where it matters or drop it",
};

/** Classify each beat with Jev. Undefined when Jev isn't available; beats whose call fails are left out. */
export async function checkBeats(registry: ModelRegistry, beats: BeatRef[], signal?: AbortSignal): Promise<BeatVerdict[] | undefined> {
	const jev = findJev(registry);
	if (!jev) return undefined;
	const judge = async (b: BeatRef): Promise<BeatVerdict | undefined> => {
		try {
			const r = await registry.classify(jev, { state: { node: b.title, beat: b.point }, questions: { kind: KIND_QUESTION } }, { signal });
			const a = r.answers.kind;
			if (r.stopReason !== "stop" || a?.type !== "choice") return undefined;
			return { ...b, kind: a.choice as BeatKind, idea: a.probabilities.idea ?? 0 };
		} catch {
			return undefined;
		}
	};
	const out: BeatVerdict[] = [];
	for (let i = 0; i < beats.length; i += 10) {
		for (const v of await Promise.all(beats.slice(i, i + 10).map(judge))) if (v) out.push(v);
	}
	return out;
}

export function isFlagged(v: BeatVerdict): boolean {
	return v.kind !== "idea";
}

export function isBorderline(v: BeatVerdict): boolean {
	return v.kind === "idea" && v.idea < BORDERLINE_IDEA;
}

/** What's wrong with a flagged beat, phrased for the agent that will fix it. */
export function beatProblem(v: BeatVerdict): string {
	return `${v.node} beat ${v.index + 1} ("${v.point}") ${PROBLEM[v.kind as Exclude<BeatKind, "idea">]}`;
}

/** Plan-review warnings: flagged beats, then borderline ones. */
export function beatWarnings(verdicts: BeatVerdict[]): string[] {
	return [
		...verdicts.filter(isFlagged).map(beatProblem),
		...verdicts.filter(isBorderline).map((v) => `${v.node} beat ${v.index + 1} may not be a single general idea ("${v.point}")`),
	];
}
