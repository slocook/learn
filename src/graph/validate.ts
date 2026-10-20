import { NODE_ID_PATTERN } from "../store/store.ts";
import type { Check, KNode } from "../types.ts";
import { findCycle } from "./graph.ts";

export const MAX_BEATS = 5;
export const MAX_CHECKS = 3;
export const LAB_RATIO_WARN = 0.2;

const OPT_OUT_LABEL = /^\s*(i\s*(do\s*not|don'?t)\s*know|not\s*sure|i'?m\s*not\s*sure|unsure)\s*\.?\s*$/i;

export interface PlanForValidation {
	/** Nodes this plan creates or reuses (reused ones carry their stored state). */
	nodes: KNode[];
	/** Nodes already in the global graph, for resolving prerequisites. */
	existing: Map<string, KNode>;
	/** Gates for nodes that will be taught, keyed by node id. Placed/reused nodes have none. */
	gates: Map<string, Check[]>;
	/** Nodes that need a gate written in this plan. */
	taught: Set<string>;
	goal?: string;
}

export interface ValidationResult {
	errors: string[];
	warnings: string[];
}

export function validateChecks(node: Pick<KNode, "id" | "kind" | "outline">, checks: Check[]): string[] {
	const errors: string[] = [];
	const where = (c: Check) => `${node.id}#${c.id}`;
	if (checks.length === 0) errors.push(`${node.id}: gate has no checks`);
	if (checks.length > MAX_CHECKS) errors.push(`${node.id}: gate has ${checks.length} checks (max ${MAX_CHECKS}); split the node`);
	const ids = new Set<string>();
	for (const c of checks) {
		if (ids.has(c.id)) errors.push(`${where(c)}: duplicate check id`);
		ids.add(c.id);
		if (!c.prompt?.trim()) errors.push(`${where(c)}: empty prompt`);
		for (const b of c.covers ?? []) {
			if (!Number.isInteger(b) || b < 0 || b >= node.outline.length) errors.push(`${where(c)}: covers beat ${b}, which does not exist`);
		}
		switch (c.type) {
			case "choice": {
				if (c.options.length < 2) errors.push(`${where(c)}: needs at least two options`);
				const values = new Set(c.options.map((o) => o.value));
				if (values.size !== c.options.length) errors.push(`${where(c)}: duplicate option values`);
				for (const o of c.options) {
					if (OPT_OUT_LABEL.test(o.label)) errors.push(`${where(c)}: option "${o.label}" duplicates the built-in "I don't know"`);
				}
				const answers = Array.isArray(c.answer) ? c.answer : [c.answer];
				if (answers.length === 0) errors.push(`${where(c)}: no correct answer`);
				for (const a of answers) if (!values.has(a)) errors.push(`${where(c)}: answer "${a}" is not an option value`);
				if (answers.length === 1 && c.options.length >= 3) {
					// The most common giveaway: the correct option is the longest by a clear margin.
					const correct = c.options.find((o) => o.value === answers[0]);
					const longestOther = Math.max(...c.options.filter((o) => o !== correct).map((o) => o.label.length));
					if (correct && correct.label.length > 1.25 * longestOther) {
						errors.push(`${where(c)}: the correct option is much longer than every distractor, which gives it away; make all options the same length and form`);
					}
				}
				break;
			}
			case "free":
				if (c.rubric.length === 0) errors.push(`${where(c)}: rubric has no ideas`);
				for (const idea of c.rubric) if (!idea.idea?.trim()) errors.push(`${where(c)}: rubric idea is empty`);
				break;
			case "numeric":
				if (!Number.isFinite(c.answer)) errors.push(`${where(c)}: answer is not a number`);
				if (!(c.tolerance >= 0)) errors.push(`${where(c)}: tolerance must be ≥ 0`);
				break;
			case "code":
				if (node.kind !== "skill") errors.push(`${where(c)}: code checks belong on skill nodes only`);
				break;
		}
	}
	const covered = new Set(checks.flatMap((c) => c.covers ?? []));
	node.outline.forEach((beat, i) => {
		if (!covered.has(i)) errors.push(`${node.id}: beat ${i} ("${beat.point}") is not covered by any check`);
	});
	return errors;
}

export function validatePlan(plan: PlanForValidation): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const all = new Map(plan.existing);
	const seen = new Set<string>();
	for (const n of plan.nodes) {
		if (!NODE_ID_PATTERN.test(n.id)) errors.push(`${n.id}: invalid id (use lowercase slugs like "linalg/jacobian")`);
		if (seen.has(n.id)) errors.push(`${n.id}: defined twice`);
		seen.add(n.id);
		all.set(n.id, n);
	}
	for (const n of plan.nodes) {
		for (const r of n.requires) {
			if (r === n.id) errors.push(`${n.id}: requires itself`);
			else if (!all.has(r)) errors.push(`${n.id}: requires unknown node "${r}"`);
		}
		if (!plan.taught.has(n.id)) continue;
		if (n.outline.length > MAX_BEATS) errors.push(`${n.id}: ${n.outline.length} beats (max ${MAX_BEATS}); split the node`);
		if (n.outline.length === 0) errors.push(`${n.id}: outline is empty`);
		else if (n.outline.length === 1) warnings.push(`${n.id}: only one beat; consider merging it into a neighbour`);
		const checks = plan.gates.get(n.id);
		if (!checks) errors.push(`${n.id}: no gate written`);
		else errors.push(...validateChecks(n, checks));
	}
	const cycle = findCycle(all);
	if (cycle) errors.push(`dependency cycle: ${cycle.join(" → ")}`);
	if (plan.goal && !all.has(plan.goal)) errors.push(`goal node "${plan.goal}" is not in the plan`);

	const taughtNodes = plan.nodes.filter((n) => plan.taught.has(n.id));
	const labs = taughtNodes.filter((n) => n.lab).length;
	if (taughtNodes.length > 0 && labs / taughtNodes.length > LAB_RATIO_WARN) {
		warnings.push(`${labs} of ${taughtNodes.length} taught nodes have labs (more than ${LAB_RATIO_WARN * 100}%); most lessons should be conversation`);
	}
	return { errors, warnings };
}
