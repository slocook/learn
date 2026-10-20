import { type KNode, type NodeState, SATISFIED_STATES, type Topic } from "../types.ts";

export function isSatisfied(state: NodeState): boolean {
	return SATISFIED_STATES.has(state);
}

/** Returns a cycle as a list of ids (first id repeated at the end), or undefined for a DAG. */
export function findCycle(nodes: Map<string, Pick<KNode, "id" | "requires">>): string[] | undefined {
	const color = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const visit = (id: string): string[] | undefined => {
		color.set(id, 1);
		stack.push(id);
		for (const req of nodes.get(id)?.requires ?? []) {
			if (!nodes.has(req)) continue;
			const c = color.get(req) ?? 0;
			if (c === 1) return [...stack.slice(stack.indexOf(req)), req];
			if (c === 0) {
				const cycle = visit(req);
				if (cycle) return cycle;
			}
		}
		stack.pop();
		color.set(id, 2);
		return undefined;
	};
	for (const id of nodes.keys()) {
		if ((color.get(id) ?? 0) === 0) {
			const cycle = visit(id);
			if (cycle) return cycle;
		}
	}
	return undefined;
}

/**
 * Topological order (prerequisites first). Ties keep the order of `preferred`, then insertion
 * order, so a planner's intended sequence survives. Throws on a cycle.
 */
export function topoSort(nodes: Map<string, Pick<KNode, "id" | "requires">>, preferred: string[] = []): string[] {
	const cycle = findCycle(nodes);
	if (cycle) throw new Error(`dependency cycle: ${cycle.join(" → ")}`);
	const rank = new Map<string, number>();
	[...preferred, ...nodes.keys()].forEach((id) => {
		if (!rank.has(id)) rank.set(id, rank.size);
	});
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const [id, n] of nodes) {
		const reqs = n.requires.filter((r) => nodes.has(r));
		indegree.set(id, reqs.length);
		for (const r of reqs) dependents.set(r, [...(dependents.get(r) ?? []), id]);
	}
	const ready = [...nodes.keys()].filter((id) => indegree.get(id) === 0);
	const order: string[] = [];
	while (ready.length > 0) {
		ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
		const id = ready.shift()!;
		order.push(id);
		for (const d of dependents.get(id) ?? []) {
			indegree.set(d, indegree.get(d)! - 1);
			if (indegree.get(d) === 0) ready.push(d);
		}
	}
	return order;
}

/** Depth of each node: 0 for nodes with no in-set prerequisites, else 1 + deepest prerequisite. */
export function depths(nodes: Map<string, Pick<KNode, "id" | "requires">>): Map<string, number> {
	const out = new Map<string, number>();
	for (const id of topoSort(nodes)) {
		const reqs = nodes.get(id)!.requires.filter((r) => nodes.has(r));
		out.set(id, reqs.length === 0 ? 0 : 1 + Math.max(...reqs.map((r) => out.get(r)!)));
	}
	return out;
}

/** The goal plus everything it transitively requires. */
export function closure(nodes: Map<string, Pick<KNode, "id" | "requires">>, goal: string): Set<string> {
	const seen = new Set<string>();
	const stack = [goal];
	while (stack.length > 0) {
		const id = stack.pop()!;
		if (seen.has(id) || !nodes.has(id)) continue;
		seen.add(id);
		stack.push(...nodes.get(id)!.requires);
	}
	return seen;
}

/**
 * Recompute locked/ready from prerequisites. Satisfied states are final and never touched; a
 * `learning` node whose prerequisites stop being satisfied (e.g. after un-placing) goes back to
 * `locked`. Returns the ids whose state changed.
 */
export function recomputeStates(nodes: Map<string, KNode>): string[] {
	const changed: string[] = [];
	for (const id of topoSort(nodes)) {
		const n = nodes.get(id)!;
		if (isSatisfied(n.state)) continue;
		const prereqsMet = n.requires.every((r) => {
			const req = nodes.get(r);
			return req !== undefined && isSatisfied(req.state);
		});
		let next: NodeState = n.state;
		if (n.state === "locked" && prereqsMet) next = "ready";
		else if ((n.state === "ready" || n.state === "learning") && !prereqsMet) next = "locked";
		if (next !== n.state) {
			n.state = next;
			changed.push(id);
		}
	}
	return changed;
}

/** The node to teach next in a topic: a node already being learned, else the first ready one. */
export function nextNode(topic: Pick<Topic, "nodes">, nodes: Map<string, KNode>): KNode | undefined {
	const inTopic = topic.nodes.map((id) => nodes.get(id)).filter((n): n is KNode => n !== undefined);
	return inTopic.find((n) => n.state === "learning") ?? inTopic.find((n) => n.state === "ready");
}

export interface TopicProgress {
	total: number;
	done: number;
	/** Nodes still to be taught (not satisfied). */
	remaining: number;
	/** Outline beats across remaining nodes, a rough effort measure. */
	beatsLeft: number;
	placed: number;
	weak: number;
}

export function topicProgress(topic: Pick<Topic, "nodes">, nodes: Map<string, KNode>): TopicProgress {
	const inTopic = topic.nodes.map((id) => nodes.get(id)).filter((n): n is KNode => n !== undefined);
	const remainingNodes = inTopic.filter((n) => !isSatisfied(n.state));
	return {
		total: inTopic.length,
		done: inTopic.length - remainingNodes.length,
		remaining: remainingNodes.length,
		beatsLeft: remainingNodes.reduce((sum, n) => sum + n.outline.length, 0),
		placed: inTopic.filter((n) => n.state === "placed").length,
		weak: inTopic.filter((n) => n.state === "weak").length,
	};
}
