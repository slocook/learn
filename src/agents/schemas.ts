import { type Static, Type } from "typebox";

const Covers = Type.Array(Type.Integer({ minimum: 0 }), {
	description: "0-based indices of the node's outline beats this check tests. Together a gate's checks must cover every beat.",
});

export const ChoiceCheckSchema = Type.Object({
	id: Type.String({ description: "Short id unique within the gate, e.g. c1." }),
	type: Type.Literal("choice"),
	prompt: Type.String(),
	covers: Covers,
	options: Type.Array(Type.Object({ value: Type.String(), label: Type.String() }), { minItems: 2 }),
	answer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: "Correct option value, or an array of values for multi-select.",
	}),
	explanation: Type.String({ description: "Why the answer is right; shown after answering." }),
});

export const FreeCheckSchema = Type.Object({
	id: Type.String(),
	type: Type.Literal("free"),
	prompt: Type.String(),
	covers: Covers,
	rubric: Type.Array(
		Type.Object({
			idea: Type.String({ description: "One required idea, stated as a claim." }),
			accept: Type.Array(Type.String(), { description: "Informal phrasings that should count, e.g. 'the elbow spins'." }),
			reject_if: Type.Optional(Type.String({ description: "The specific misconception that fails this idea, if any." })),
		}),
		{ minItems: 1 },
	),
	model_answer: Type.String({ description: "A short exemplary answer, shown after grading." }),
});

export const NumericCheckSchema = Type.Object({
	id: Type.String(),
	type: Type.Literal("numeric"),
	prompt: Type.String(),
	covers: Covers,
	answer: Type.Number(),
	tolerance: Type.Number({ minimum: 0 }),
	relative: Type.Optional(Type.Boolean({ description: "Tolerance is a fraction of the answer instead of absolute." })),
	unit: Type.Optional(Type.String()),
	explanation: Type.String(),
});

export const CodeCheckSchema = Type.Object({
	id: Type.String(),
	type: Type.Literal("code"),
	prompt: Type.String({ description: "What to implement, naming the function(s) and their behaviour." }),
	covers: Covers,
	solution_file: Type.String({ description: "Filled in by the lab builder; leave empty." }),
	test_file: Type.String({ description: "Filled in by the lab builder; leave empty." }),
});

export const CheckSchema = Type.Union([ChoiceCheckSchema, FreeCheckSchema, NumericCheckSchema, CodeCheckSchema]);

export const InterviewSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String(),
			options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }), {
				minItems: 2,
				maxItems: 5,
			}),
			multi: Type.Optional(Type.Boolean()),
		}),
		{ minItems: 1, maxItems: 4 },
	),
});

export const GoalSchema = Type.Object({
	slug: Type.String({ description: "Short lowercase slug for the topic, e.g. 'ik'." }),
	title: Type.String({ description: "Short display title, e.g. 'Inverse kinematics'." }),
	goal: Type.String({ description: "The concrete learning goal: what the learner will be able to do at the end." }),
});

export const ResearchSchema = Type.Object({
	brief: Type.String({ description: "The research brief in markdown, with inline source links." }),
});

export const StrandsSchema = Type.Object({
	strands: Type.Array(
		Type.Object({
			name: Type.String({ description: "Short name, e.g. 'Trigonometry'." }),
			description: Type.String({ description: "What this prerequisite strand covers, from basic to advanced." }),
		}),
		{ maxItems: 7 },
	),
});

export const LaddersSchema = Type.Object({
	ladders: Type.Array(
		Type.Object({
			strand: Type.String({ description: "Strand name, exactly as given." }),
			rungs: Type.Array(
				Type.Object({
					covers: Type.String({ description: "What passing this rung shows the learner knows." }),
					check: Type.Union([ChoiceCheckSchema, NumericCheckSchema]),
				}),
				{ minItems: 3, maxItems: 6 },
			),
		}),
	),
});

const BeatSchema = Type.Object({
	point: Type.String({ description: "One point to establish." }),
	motivation: Type.Optional(Type.String({ description: "Why the learner needs it now / how it could be discovered." })),
});

export const LabSpecSchema = Type.Object({
	type: Type.Union([Type.Literal("skill"), Type.Literal("exploration")]),
	justification: Type.String({ description: "Why a lab is much better than conversation for this node." }),
	spec: Type.String({ description: "What the lab contains: functions to implement, plots, sliders." }),
});

export const PlanNodeSchema = Type.Object({
	id: Type.String({ description: "Lowercase slug named for the idea, e.g. 'linalg/jacobian'. Reuse existing ids exactly." }),
	title: Type.String({ description: "Short name for the idea, at most ~8 words, e.g. 'Two elbow solutions for 2-link IK'." }),
	kind: Type.Union([Type.Literal("concept"), Type.Literal("derivation"), Type.Literal("skill")]),
	requires: Type.Array(Type.String()),
	outline: Type.Array(BeatSchema, { maxItems: 5 }),
	status: Type.Union([Type.Literal("new"), Type.Literal("placed"), Type.Literal("reuse")], {
		description: "new = teach it; placed = below the learner's frontier, never taught; reuse = an existing node id.",
	}),
	strand: Type.Optional(Type.String()),
	lab: Type.Optional(LabSpecSchema),
});

export const PlanSchema = Type.Object({
	goal_node: Type.String(),
	nodes: Type.Array(PlanNodeSchema),
	approach: Type.String({ description: "A few sentences: what is covered, in what order, and why this way." }),
});

export const GatesSchema = Type.Object({
	gates: Type.Array(Type.Object({ node: Type.String(), checks: Type.Array(CheckSchema, { minItems: 1, maxItems: 3 }) })),
});

export const FreeGradeSchema = Type.Object({
	ideas: Type.Array(
		Type.Object({
			index: Type.Integer({ minimum: 0 }),
			status: Type.Union([
				Type.Literal("present"),
				Type.Literal("missing"),
				Type.Literal("contradicted"),
				Type.Literal("unclear"),
			]),
			note: Type.Optional(Type.String()),
		}),
	),
	follow_up: Type.Optional(Type.String({ description: "One clarifying question, only if an idea is unclear." })),
});

export const SummarySchema = Type.Object({
	notes: Type.String({ description: "Learner-facing markdown notes on what was learned, in the learner's terms." }),
	evidence: Type.String({ description: "One or two sentences for the record: what landed, what was shaky." }),
});

export const SplitSchema = Type.Object({
	nodes: Type.Array(PlanNodeSchema, { minItems: 1, maxItems: 2 }),
	reason: Type.String(),
});

export const RepeatSchema = Type.Object({ same: Type.Boolean(), matches: Type.Optional(Type.String()) });

export const DiagramResultSchema = Type.Object({
	status: Type.Union([Type.Literal("ok"), Type.Literal("none")]),
	file: Type.Optional(Type.String({ description: "Published filename from render_* with save_as." })),
	reason: Type.Optional(Type.String()),
});

export const LabResultSchema = Type.Object({
	status: Type.Union([Type.Literal("ok"), Type.Literal("failed")]),
	notes: Type.String({ description: "What the lab contains and how to use it, for the learner." }),
	reason: Type.Optional(Type.String()),
});

export type PlanNodeOut = Static<typeof PlanNodeSchema>;
export type PlanOut = Static<typeof PlanSchema>;
