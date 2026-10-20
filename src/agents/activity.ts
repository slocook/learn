import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type RunStatus = "running" | "done" | "failed" | "aborted";

export interface RunRecord {
	id: string;
	role: string;
	/** Short description of what this run is doing, e.g. "scope research: inverse kinematics". */
	label: string;
	model: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	/** Current step, e.g. "web_fetch en.wikipedia.org/wiki/…" or "writing". */
	step: string;
	tokens: number;
	cost: number;
	toolCalls: number;
	error?: string;
	messages: AgentMessage[];
	/** Rendered images produced along the way (diagram previews), as file paths. */
	previews: string[];
}

type Listener = (run: RunRecord) => void;

const MAX_RUNS = 100;

/**
 * Process-wide registry of subagent runs. Widgets, inline tool renderers and the /agents overlay
 * all read from here, so every run is visible no matter what started it.
 */
class ActivityRegistry {
	private readonly runs = new Map<string, RunRecord>();
	private readonly listeners = new Set<Listener>();
	private counter = 0;

	start(role: string, label: string, model: string): RunRecord {
		const run: RunRecord = {
			id: `${Date.now().toString(36)}-${(++this.counter).toString(36)}`,
			role,
			label,
			model,
			status: "running",
			startedAt: Date.now(),
			step: "starting",
			tokens: 0,
			cost: 0,
			toolCalls: 0,
			messages: [],
			previews: [],
		};
		this.runs.set(run.id, run);
		this.trim();
		this.emit(run);
		return run;
	}

	update(run: RunRecord, patch: Partial<RunRecord>): void {
		Object.assign(run, patch);
		this.emit(run);
	}

	finish(run: RunRecord, status: Exclude<RunStatus, "running">, error?: string): void {
		Object.assign(run, { status, error, endedAt: Date.now(), step: status });
		this.emit(run);
	}

	running(): RunRecord[] {
		return [...this.runs.values()].filter((r) => r.status === "running");
	}

	recent(): RunRecord[] {
		return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	get(id: string): RunRecord | undefined {
		return this.runs.get(id);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(run: RunRecord): void {
		for (const l of this.listeners) {
			try {
				l(run);
			} catch {
				// A broken listener must not break the run it observes.
			}
		}
	}

	private trim(): void {
		const done = this.recent().filter((r) => r.status !== "running");
		for (const r of done.slice(MAX_RUNS)) this.runs.delete(r.id);
	}
}

const KEY = Symbol.for("pi-learn.activity");
// Shared across extension reloads within one process so in-flight runs stay visible.
export const activity: ActivityRegistry = ((globalThis as Record<symbol, unknown>)[KEY] ??= new ActivityRegistry()) as ActivityRegistry;

export function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
