import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { Check, Evidence, Gate, KNode, Topic } from "../types.ts";
import { formatFrontmatter, parseFrontmatter } from "./frontmatter.ts";
import { canonicalJson, sha256 } from "./hash.ts";

export const NODE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

const LINKS_START = "<!-- learn:links -->";
const LINKS_END = "<!-- /learn:links -->";
const NOTES_HEADING = "## Notes";

export interface StorePaths {
	root: string;
	knowledge: string;
	learn: string;
	gates: string;
	topics: string;
	evidence: string;
	maps: string;
	viz: string;
	labs: string;
	hiddenLabs: string;
	agents: string;
	config: string;
}

export function storePaths(root: string, knowledgeDir = "knowledge"): StorePaths {
	const learn = path.join(root, ".learn");
	return {
		root,
		knowledge: path.join(root, knowledgeDir),
		learn,
		gates: path.join(learn, "gates"),
		topics: path.join(learn, "topics"),
		evidence: path.join(learn, "evidence.jsonl"),
		maps: path.join(root, "maps"),
		viz: path.join(root, "viz"),
		labs: path.join(root, "labs"),
		hiddenLabs: path.join(learn, "labs"),
		agents: path.join(learn, "agents"),
		config: path.join(learn, "config.yaml"),
	};
}

export function gateHash(checks: Check[]): string {
	return sha256(canonicalJson(checks));
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkMarkdown(full, out);
		else if (entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

function writeFileAtomic(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, "utf8");
	fs.renameSync(tmp, file);
}

/** Files-on-disk store for the knowledge graph, gates, topics, and evidence. */
export class KnowledgeStore {
	readonly paths: StorePaths;

	constructor(root: string, knowledgeDir = "knowledge") {
		this.paths = storePaths(root, knowledgeDir);
	}

	// ── Nodes ────────────────────────────────────────────────────────────────

	nodeFile(id: string): string {
		return path.join(this.paths.knowledge, `${id}.md`);
	}

	loadNodes(): Map<string, KNode> {
		const nodes = new Map<string, KNode>();
		for (const file of walkMarkdown(this.paths.knowledge)) {
			const { data } = parseFrontmatter<Partial<KNode>>(fs.readFileSync(file, "utf8"));
			if (data && typeof data.id === "string" && data.state) nodes.set(data.id, normalizeNode(data));
		}
		return nodes;
	}

	getNode(id: string): KNode | undefined {
		const file = this.nodeFile(id);
		if (!fs.existsSync(file)) return undefined;
		const { data } = parseFrontmatter<Partial<KNode>>(fs.readFileSync(file, "utf8"));
		return data?.id ? normalizeNode(data) : undefined;
	}

	/** Write a node's frontmatter, keeping its notes and regenerating its links block. */
	saveNode(node: KNode, titles?: Map<string, string>): void {
		if (!NODE_ID_PATTERN.test(node.id)) throw new Error(`invalid node id "${node.id}"`);
		const file = this.nodeFile(node.id);
		const existingBody = fs.existsSync(file) ? parseFrontmatter(fs.readFileSync(file, "utf8")).body : undefined;
		const linkLine =
			node.requires.length > 0
				? `**Builds on:** ${node.requires.map((r) => `[[${r}|${titles?.get(r) ?? r}]]`).join(" · ")}`
				: "**Builds on:** nothing in this graph; it is a starting point.";
		const linksBlock = `${LINKS_START}\n${linkLine}\n${LINKS_END}`;
		let body: string;
		if (existingBody === undefined) {
			body = `# ${node.title}\n\n${linksBlock}\n\n${NOTES_HEADING}\n`;
		} else if (existingBody.includes(LINKS_START) && existingBody.includes(LINKS_END)) {
			const start = existingBody.indexOf(LINKS_START);
			const end = existingBody.indexOf(LINKS_END) + LINKS_END.length;
			body = existingBody.slice(0, start) + linksBlock + existingBody.slice(end);
		} else {
			body = `${linksBlock}\n\n${existingBody}`;
		}
		writeFileAtomic(file, formatFrontmatter({ ...node, updated: new Date().toISOString() }, body));
	}

	/** Append learner-facing notes (e.g. a lesson summary) under the node's Notes heading. */
	appendNotes(id: string, markdown: string): void {
		const file = this.nodeFile(id);
		if (!fs.existsSync(file)) throw new Error(`unknown node "${id}"`);
		const { data, body } = parseFrontmatter<KNode>(fs.readFileSync(file, "utf8"));
		const withHeading = body.includes(NOTES_HEADING) ? body : `${body.trimEnd()}\n\n${NOTES_HEADING}\n`;
		writeFileAtomic(file, formatFrontmatter(data, `${withHeading.trimEnd()}\n\n${markdown.trim()}\n`));
	}

	// ── Gates ────────────────────────────────────────────────────────────────

	gateFile(id: string): string {
		return path.join(this.paths.gates, `${id}.yaml`);
	}

	getGate(id: string): Gate | undefined {
		const file = this.gateFile(id);
		if (!fs.existsSync(file)) return undefined;
		return YAML.parse(fs.readFileSync(file, "utf8")) as Gate;
	}

	/** Freeze a gate. Refuses to replace an existing frozen gate. */
	freezeGate(node: string, checks: Check[]): Gate {
		const file = this.gateFile(node);
		if (fs.existsSync(file)) throw new Error(`gate for "${node}" is already frozen`);
		const gate: Gate = { node, checks, hash: gateHash(checks), frozen_at: new Date().toISOString() };
		writeFileAtomic(file, YAML.stringify(gate, { lineWidth: 0 }));
		return gate;
	}

	/** True when the gate on disk still matches the hash taken when it was frozen. */
	verifyGate(gate: Gate): boolean {
		return gateHash(gate.checks) === gate.hash;
	}

	// ── Topics ───────────────────────────────────────────────────────────────

	topicFile(slug: string): string {
		return path.join(this.paths.topics, `${slug}.yaml`);
	}

	listTopics(): Topic[] {
		if (!fs.existsSync(this.paths.topics)) return [];
		return fs
			.readdirSync(this.paths.topics)
			.filter((f) => f.endsWith(".yaml"))
			.map((f) => YAML.parse(fs.readFileSync(path.join(this.paths.topics, f), "utf8")) as Topic)
			.filter((t) => t && typeof t.slug === "string");
	}

	getTopic(slug: string): Topic | undefined {
		const file = this.topicFile(slug);
		if (!fs.existsSync(file)) return undefined;
		return YAML.parse(fs.readFileSync(file, "utf8")) as Topic;
	}

	saveTopic(topic: Topic): void {
		writeFileAtomic(this.topicFile(topic.slug), YAML.stringify(topic, { lineWidth: 0 }));
	}

	topicDir(slug: string): string {
		return path.join(this.paths.topics, slug);
	}

	// ── Evidence ─────────────────────────────────────────────────────────────

	appendEvidence(entry: Omit<Evidence, "at"> & { at?: string }): void {
		fs.mkdirSync(path.dirname(this.paths.evidence), { recursive: true });
		const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
		fs.appendFileSync(this.paths.evidence, `${line}\n`, "utf8");
	}

	readEvidence(filter?: (e: Evidence) => boolean): Evidence[] {
		if (!fs.existsSync(this.paths.evidence)) return [];
		const out: Evidence[] = [];
		for (const line of fs.readFileSync(this.paths.evidence, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as Evidence;
				if (!filter || filter(e)) out.push(e);
			} catch {
				// A torn final line from a crash is skipped rather than failing every read.
			}
		}
		return out;
	}
}

function normalizeNode(data: Partial<KNode>): KNode {
	const now = new Date().toISOString();
	return {
		id: data.id!,
		title: data.title ?? data.id!,
		kind: data.kind ?? "concept",
		requires: data.requires ?? [],
		outline: data.outline ?? [],
		state: data.state ?? "locked",
		topics: data.topics ?? [],
		strand: data.strand,
		lab: data.lab,
		created: data.created ?? now,
		updated: data.updated ?? now,
	};
}
