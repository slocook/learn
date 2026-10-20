import type { NodeState } from "../types.ts";
import { isSatisfied } from "./graph.ts";

/**
 * Explicit node transitions. Unlocking (locked ⇄ ready) is derived from prerequisites by
 * `recomputeStates`; everything else goes through here so no caller can skip a rule.
 */
export type NodeEvent =
	| "start" // a lesson begins
	| "pass" // the whole gate passed (also test-out from ready)
	| "assist" // attempts exhausted, learner chose pass-with-assistance
	| "weak" // attempts exhausted, learner chose to move on
	| "override" // learner closed the gate with /pass
	| "unplace" // a placed node turned out not to be known
	| "split"; // attempts exhausted, learner chose to split; new prereqs relock it

const TRANSITIONS: Record<NodeEvent, { from: (s: NodeState) => boolean; to: NodeState }> = {
	start: { from: (s) => s === "ready" || s === "learning", to: "learning" },
	pass: { from: (s) => s === "ready" || s === "learning", to: "passed" },
	assist: { from: (s) => s === "learning", to: "passed-assisted" },
	weak: { from: (s) => s === "learning", to: "weak" },
	override: { from: (s) => !isSatisfied(s) || s === "placed", to: "passed-override" },
	unplace: { from: (s) => s === "placed", to: "ready" },
	split: { from: (s) => s === "learning", to: "locked" },
};

export function transition(state: NodeState, event: NodeEvent): NodeState {
	const rule = TRANSITIONS[event];
	if (!rule.from(state)) throw new Error(`cannot ${event} a node in state "${state}"`);
	return rule.to;
}

export function canTransition(state: NodeState, event: NodeEvent): boolean {
	return TRANSITIONS[event].from(state);
}
