// Core data model. Plain types for storage; TypeBox schemas for subagent outputs live in
// src/agents/schemas.ts.

export type NodeKind = "concept" | "derivation" | "skill";

export type NodeState =
	| "locked"
	| "ready"
	| "learning"
	| "passed"
	| "passed-assisted"
	| "passed-override"
	| "weak"
	| "placed";

/** States that count as satisfied for unlocking dependents. */
export const SATISFIED_STATES: ReadonlySet<NodeState> = new Set([
	"passed",
	"passed-assisted",
	"passed-override",
	"weak",
	"placed",
]);

export interface Beat {
	point: string;
	motivation?: string;
}

export interface LabRef {
	type: "skill" | "exploration";
	justification: string;
	/** What the lab should contain, written by the planner. */
	spec: string;
	/** Learner-facing directory, relative to the project root, once built. */
	path?: string;
	built?: boolean;
}

export interface KNode {
	id: string;
	title: string;
	kind: NodeKind;
	requires: string[];
	outline: Beat[];
	state: NodeState;
	topics: string[];
	/** Placement strand this node belongs to, if any. */
	strand?: string;
	lab?: LabRef;
	created: string;
	updated: string;
}

export interface CheckBase {
	id: string;
	prompt: string;
	/** Outline beat indices (0-based) this check covers. */
	covers: number[];
}

export interface ChoiceCheck extends CheckBase {
	type: "choice";
	options: { value: string; label: string }[];
	answer: string | string[];
	explanation: string;
}

export interface RubricIdea {
	idea: string;
	accept: string[];
	reject_if?: string;
}

export interface FreeCheck extends CheckBase {
	type: "free";
	rubric: RubricIdea[];
	model_answer: string;
}

export interface NumericCheck extends CheckBase {
	type: "numeric";
	answer: number;
	tolerance: number;
	relative?: boolean;
	unit?: string;
	explanation: string;
}

export interface CodeCheck extends CheckBase {
	type: "code";
	/** Learner-editable solution module, relative to the project root. */
	solution_file: string;
	/** Hidden pytest file, relative to the project root (inside .learn/). */
	test_file: string;
}

export type Check = ChoiceCheck | FreeCheck | NumericCheck | CodeCheck;

export interface Gate {
	node: string;
	checks: Check[];
	hash: string;
	frozen_at: string;
}

export interface BacklogItem {
	text: string;
	from_node?: string;
	at: string;
}

export type SelfReport = "never" | "heard" | "use" | "derive";

export interface LadderRung {
	level: number;
	covers: string;
	check: ChoiceCheck | NumericCheck;
}

export interface StrandPlacement {
	name: string;
	description: string;
	self_report?: SelfReport;
	/** Index of the highest rung passed; -1 when none. */
	frontier: number;
	ladder: LadderRung[];
	asked: { rung: number; correct: boolean; dont_know?: boolean }[];
}

export interface LessonProgress {
	node: string;
	started_at: string;
	beats_done: number[];
	turns: number;
	/** Practice questions posed, keyed by beat index. */
	practice: Record<string, number>;
	/** Practice questions answered correctly in this lesson. */
	practice_correct: string[];
	gate: GateProgress;
}

export interface GateProgress {
	passed_checks: string[];
	attempts: Record<string, number>;
}

export type TopicStatus = "planning" | "active" | "done";

export interface Topic {
	slug: string;
	title: string;
	goal: string;
	goal_node?: string;
	/** Node ids in teaching (topological) order. */
	nodes: string[];
	status: TopicStatus;
	created: string;
	research?: string;
	placement?: StrandPlacement[];
	backlog: BacklogItem[];
	lesson?: LessonProgress;
}

export type EvidenceKind =
	| "gate_attempt"
	| "practice"
	| "override"
	| "dispute"
	| "beat"
	| "view_rubric"
	| "park"
	| "state"
	| "placement"
	| "lesson_summary"
	| "test_out"
	| "outline_rewrite";

export interface Evidence {
	at: string;
	kind: EvidenceKind;
	node?: string;
	topic?: string;
	data?: Record<string, unknown>;
}
