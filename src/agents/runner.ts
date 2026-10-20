import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	type ModelRegistry,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { type LearnConfig, parseModelRef, type Role, type ThinkingSetting } from "../config.ts";
import { activity, type RunRecord } from "./activity.ts";

const PACKAGE_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

export interface AgentEnv {
	cwd: string;
	config: LearnConfig;
	registry: ModelRegistry;
	/** The session's current model, used for roles set to "inherit". */
	fallbackModel?: Model<any>;
	signal?: AbortSignal;
}

export interface AgentSpec<S extends TSchema | undefined = undefined> {
	role: Role;
	/** Prompt file name in agents/ (without .md). A project copy in .learn/agents/ wins. */
	prompt: string;
	/** Shown in the activity widget and /agents. */
	label: string;
	task: string;
	tools?: ToolDefinition<any, any>[];
	/** When set, the agent must finish by calling `submit` with data matching this schema. */
	output?: S;
	images?: ImageContent[];
	/** Called on every activity update for this run. */
	onUpdate?: (run: RunRecord) => void;
}

export interface AgentResult<T> {
	output: T | undefined;
	text: string;
	run: RunRecord;
}

export class AgentError extends Error {
	readonly run: RunRecord;
	constructor(message: string, run: RunRecord) {
		super(message);
		this.run = run;
	}
}

/** Read an agent prompt, preferring a project override in .learn/agents/. */
export function loadAgentPrompt(cwd: string, name: string): string {
	const override = path.join(cwd, ".learn", "agents", `${name}.md`);
	const file = fs.existsSync(override) ? override : path.join(PACKAGE_AGENTS_DIR, `${name}.md`);
	return fs.readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
}

export interface ResolvedModel {
	model: Model<any>;
	thinking?: ThinkingSetting;
	/** Set when the configured model could not be used and the session model stood in. */
	fallbackReason?: string;
}

export function resolveRoleModel(env: Pick<AgentEnv, "config" | "registry" | "fallbackModel">, role: Role): ResolvedModel {
	const rc = env.config.models[role] ?? {};
	const ref = rc.model && rc.model !== "inherit" ? parseModelRef(rc.model) : undefined;
	let fallbackReason: string | undefined;
	if (ref) {
		const model = env.registry.find(ref.provider, ref.id);
		if (model && env.registry.hasConfiguredAuth(model)) return { model, thinking: rc.thinking };
		fallbackReason = model ? `no credentials for ${rc.model}` : `unknown model ${rc.model}`;
	}
	if (!env.fallbackModel) throw new Error(`no model available for role "${role}"${fallbackReason ? ` (${fallbackReason})` : ""}`);
	return { model: env.fallbackModel, thinking: rc.thinking, fallbackReason };
}

function emptyResourceLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function modelRuntimeFor(registry: ModelRegistry): Promise<ModelRuntime> {
	// The registry wraps the session's runtime; reusing it shares credentials and custom providers.
	const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
	return runtime ?? (await ModelRuntime.create());
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const pick = a.url ?? a.query ?? a.path ?? a.save_as ?? a.name ?? a.question;
	if (typeof pick === "string") {
		const s = pick.replace(/^https?:\/\/(www\.)?/, "");
		return s.length > 70 ? `${s.slice(0, 67)}…` : s;
	}
	return "";
}

const SUBMIT_REMINDER =
	"You have not called `submit` yet. Call `submit` now with your final result. Do not reply with text instead.";

/**
 * Run one subagent in-process: its own model, system prompt and tools, no extensions, an
 * in-memory session. Progress is published to the activity registry while it runs.
 */
export async function runAgent<S extends TSchema | undefined = undefined>(
	env: AgentEnv,
	spec: AgentSpec<S>,
): Promise<AgentResult<S extends TSchema ? Static<S> : undefined>> {
	type Out = S extends TSchema ? Static<S> : undefined;
	const resolved = resolveRoleModel(env, spec.role);
	const run = activity.start(spec.role, spec.label, `${resolved.model.provider}/${resolved.model.id}`);
	const notify = () => spec.onUpdate?.(run);
	const unsubscribeActivity = activity.subscribe((r) => {
		if (r === run) notify();
	});

	let submitted: Out | undefined;
	const tools: ToolDefinition<any, any>[] = [...(spec.tools ?? [])];
	if (spec.output) {
		tools.push({
			name: "submit",
			label: "submit",
			description: "Submit your final result. Call exactly once, when you are done.",
			parameters: spec.output,
			async execute(_id, params) {
				submitted = params as Out;
				return { content: [{ type: "text", text: "Submitted." }], details: undefined, terminate: true };
			},
		});
	}

	let systemPrompt = loadAgentPrompt(env.cwd, spec.prompt);
	if (env.config.learner.notes.trim() && (spec.role === "teacher" || spec.role === "planner")) {
		systemPrompt += `\n\n## About this learner\n\n${env.config.learner.notes.trim()}`;
	}

	const timeoutMs = env.config.agents.timeout_minutes * 60_000;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void session?.abort();
	}, timeoutMs);
	const onAbort = () => void session?.abort();
	env.signal?.addEventListener("abort", onAbort);

	try {
		const created = await createAgentSession({
			cwd: env.cwd,
			model: resolved.model,
			thinkingLevel: resolved.thinking,
			modelRuntime: await modelRuntimeFor(env.registry),
			resourceLoader: emptyResourceLoader(systemPrompt),
			tools: tools.map((t) => t.name),
			customTools: tools as ToolDefinition[],
			sessionManager: SessionManager.inMemory(env.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
		});
		session = created.session;
		const s = session;
		if (resolved.fallbackReason) activity.update(run, { step: `using session model (${resolved.fallbackReason})` });

		s.subscribe((event) => {
			switch (event.type) {
				case "tool_execution_start":
					activity.update(run, { step: `${event.toolName} ${summarizeArgs(event.args)}`.trim(), toolCalls: run.toolCalls + 1 });
					break;
				case "message_update": {
					const t = event.assistantMessageEvent.type;
					if (t === "thinking_delta" && run.step !== "thinking") activity.update(run, { step: "thinking" });
					else if (t === "text_delta" && run.step !== "writing") activity.update(run, { step: "writing" });
					break;
				}
				case "message_end": {
					const m = event.message as AgentMessage & { role: string; usage?: { totalTokens: number; cost: { total: number } } };
					if (m.role === "assistant" && m.usage) {
						activity.update(run, { tokens: run.tokens + m.usage.totalTokens, cost: run.cost + m.usage.cost.total });
					}
					break;
				}
			}
		});

		await s.prompt(spec.task, { images: spec.images, expandPromptTemplates: false });
		if (spec.output && submitted === undefined && !timedOut && !env.signal?.aborted) {
			await s.prompt(SUBMIT_REMINDER, { expandPromptTemplates: false });
		}
		run.messages = [...s.messages];

		const last = [...s.messages].reverse().find((m) => (m as { role: string }).role === "assistant") as
			| { stopReason?: string; errorMessage?: string }
			| undefined;
		if (timedOut) throw new AgentError(`timed out after ${env.config.agents.timeout_minutes} min`, run);
		if (env.signal?.aborted) {
			activity.finish(run, "aborted");
			throw new AgentError("aborted", run);
		}
		if (last?.stopReason === "error") throw new AgentError(last.errorMessage ?? "model error", run);
		if (spec.output && submitted === undefined) throw new AgentError("finished without submitting a result", run);

		activity.finish(run, "done");
		return { output: submitted, text: s.getLastAssistantText() ?? "", run };
	} catch (e) {
		if (run.status === "running") activity.finish(run, "failed", (e as Error).message);
		if (session) run.messages = [...session.messages];
		throw e instanceof AgentError ? e : new AgentError((e as Error).message, run);
	} finally {
		clearTimeout(timer);
		env.signal?.removeEventListener("abort", onAbort);
		unsubscribeActivity();
		session?.dispose();
	}
}
