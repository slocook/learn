import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KNode, NodeState } from "../src/types.ts";

export function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-learn-test-"));
}

export function node(id: string, requires: string[] = [], state: NodeState = "locked", beats = 2): KNode {
	return {
		id,
		title: id,
		kind: "concept",
		requires,
		outline: Array.from({ length: beats }, (_, i) => ({ point: `${id} point ${i}` })),
		state,
		topics: ["t"],
		created: "2026-01-01T00:00:00.000Z",
		updated: "2026-01-01T00:00:00.000Z",
	};
}

export function graph(...nodes: KNode[]): Map<string, KNode> {
	return new Map(nodes.map((n) => [n.id, n]));
}
