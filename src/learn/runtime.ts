import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import type { AgentEnv } from "../agents/runner.ts";
import { type LearnConfig, loadConfig } from "../config.ts";
import { recomputeStates } from "../graph/graph.ts";
import { KnowledgeStore } from "../store/store.ts";
import type { KNode, Topic } from "../types.ts";

interface ProjectState {
	active_topic?: string;
}

/** Ephemeral state of a gate being taken; lives only in memory. */
export interface GateRunState {
	node: string;
	topic?: string;
	/** True for test-out from a ready node before any lesson. */
	testOut: boolean;
	/** Attempts count only once the gate is ready (all beats done) or on test-out they never count. */
	counts: boolean;
	checkIds: string[];
	index: number;
	awaiting?: { kind: "free" | "code" | "follow_up"; checkId: string };
	followUp?: { question: string; firstAnswer: string };
	results: { checkId: string; passed: boolean; detail: string; missed?: string[]; answer?: string }[];
}

/** Shared state and helpers for the learn extension. One per extension runtime. */
export class LearnRuntime {
	readonly pi: ExtensionAPI;
	cwd = process.cwd();
	gateRun: GateRunState | undefined;
	/** Set by offer_gate; the gate starts once the agent settles. */
	pendingGate: string | undefined;
	/** Last failed free-answer grading, for /dispute. */
	lastFailedFree: { node: string; checkId: string; answer: string; missed: string[] } | undefined;
	private configCache: { at: number; config: LearnConfig } | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	get config(): LearnConfig {
		// Re-read at most once a second so edits to config.yaml apply without /reload.
		if (!this.configCache || Date.now() - this.configCache.at > 1000) {
			this.configCache = { at: Date.now(), config: loadConfig(this.cwd) };
		}
		return this.configCache.config;
	}

	get store(): KnowledgeStore {
		return new KnowledgeStore(this.cwd, this.config.knowledge_dir);
	}

	agentEnv(ctx: ExtensionContext, signal?: AbortSignal): AgentEnv {
		return { cwd: this.cwd, config: this.config, registry: ctx.modelRegistry, fallbackModel: ctx.model, signal };
	}

	// ── Project state ────────────────────────────────────────────────────────

	private stateFile(): string {
		return path.join(this.cwd, ".learn", "state.yaml");
	}

	private readState(): ProjectState {
		const file = this.stateFile();
		return fs.existsSync(file) ? ((YAML.parse(fs.readFileSync(file, "utf8")) as ProjectState) ?? {}) : {};
	}

	setActiveTopic(slug: string | undefined): void {
		fs.mkdirSync(path.dirname(this.stateFile()), { recursive: true });
		fs.writeFileSync(this.stateFile(), YAML.stringify({ ...this.readState(), active_topic: slug }), "utf8");
	}

	activeTopic(): Topic | undefined {
		const slug = this.readState().active_topic;
		return slug ? this.store.getTopic(slug) : undefined;
	}

	/** The topic and node of the lesson in progress, if any. */
	activeLesson(): { topic: Topic; node: KNode } | undefined {
		const topic = this.activeTopic();
		if (!topic?.lesson) return undefined;
		const node = this.store.getNode(topic.lesson.node);
		return node ? { topic, node } : undefined;
	}

	/** Recompute locked/ready across the whole graph and persist what changed. */
	recompute(): Map<string, KNode> {
		const store = this.store;
		const nodes = store.loadNodes();
		const titles = new Map([...nodes.values()].map((n) => [n.id, n.title]));
		for (const id of recomputeStates(nodes)) store.saveNode(nodes.get(id)!, titles);
		return nodes;
	}

	titles(nodes?: Map<string, KNode>): Map<string, string> {
		const all = nodes ?? this.store.loadNodes();
		return new Map([...all.values()].map((n) => [n.id, n.title]));
	}

	/** Show a status line in the transcript without sending it to the model. */
	note(text: string, level: "info" | "success" | "warning" | "error" = "info"): void {
		this.pi.appendEntry("learn-note", { text, level });
		this.pi.events.emit("learn:note", { text, level });
	}
}
