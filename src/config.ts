import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

export const ROLES = [
	"teacher",
	"researcher",
	"planner",
	"gate_writer",
	"grader",
	"diagram",
	"lab",
	"summarizer",
] as const;
export type Role = (typeof ROLES)[number];

export type ThinkingSetting = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RoleConfig {
	/** "provider/model-id", or "inherit" to use the session's current model. */
	model?: string;
	thinking?: ThinkingSetting;
}

export interface LearnConfig {
	models: Record<Role, RoleConfig>;
	grader: { backend: "jev" | "llm" };
	gate: { attempts: number; practice_per_beat: number };
	lesson: { turns_per_beat: number };
	placement: { max_per_strand: number; max_total: number };
	search: { provider: "auto" | "native" | "brave" | "tavily" | "duckduckgo" };
	render: { chrome?: string };
	agents: { timeout_minutes: number };
	knowledge_dir: string;
	learner: { notes: string };
}

export const DEFAULT_CONFIG: LearnConfig = {
	models: {
		teacher: { model: "inherit" },
		researcher: { model: "inherit", thinking: "medium" },
		planner: { model: "inherit", thinking: "high" },
		gate_writer: { model: "inherit", thinking: "high" },
		grader: { model: "inherit", thinking: "low" },
		diagram: { model: "inherit", thinking: "low" },
		lab: { model: "inherit", thinking: "medium" },
		summarizer: { model: "inherit", thinking: "low" },
	},
	grader: { backend: "jev" },
	gate: { attempts: 3, practice_per_beat: 2 },
	lesson: { turns_per_beat: 6 },
	placement: { max_per_strand: 3, max_total: 15 },
	search: { provider: "auto" },
	render: {},
	agents: { timeout_minutes: 15 },
	knowledge_dir: "knowledge",
	learner: { notes: "" },
};

export function globalConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "learn.yaml");
}

export function projectConfigPath(root: string): string {
	return path.join(root, ".learn", "config.yaml");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, override: unknown): T {
	if (!isPlainObject(base) || !isPlainObject(override)) return (override ?? base) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(override)) {
		if (v === undefined || v === null) continue;
		out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
	}
	return out as T;
}

function readYaml(file: string): unknown {
	if (!fs.existsSync(file)) return undefined;
	return YAML.parse(fs.readFileSync(file, "utf8"));
}

/** Defaults, then ~/.pi/agent/learn.yaml, then <project>/.learn/config.yaml. */
export function loadConfig(root: string): LearnConfig {
	return deepMerge(deepMerge(DEFAULT_CONFIG, readYaml(globalConfigPath())), readYaml(projectConfigPath(root)));
}

/** Split "provider/model-id". The id may itself contain slashes (e.g. openrouter models). */
export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export const EXAMPLE_CONFIG = `# pi-learn configuration. Project values override ~/.pi/agent/learn.yaml.
# Models are "provider/model-id"; "inherit" uses whatever model the pi session is on.
models:
  teacher:     { model: inherit }
  researcher:  { model: inherit, thinking: medium }
  planner:     { model: inherit, thinking: high }
  gate_writer: { model: inherit, thinking: high }
  grader:      { model: inherit, thinking: low }   # used when Jev is unavailable or unsure
  diagram:     { model: inherit, thinking: low }
  lab:         { model: inherit, thinking: medium }
  summarizer:  { model: inherit, thinking: low }
grader:
  backend: jev          # jev (needs TYPESAFE_API_KEY) or llm
gate:
  attempts: 3           # tries per check before you choose how to move on
  practice_per_beat: 2  # practice questions the teacher may ask per beat
lesson:
  turns_per_beat: 6     # turn budget per outline beat
placement:
  max_per_strand: 3
  max_total: 15
search:
  provider: auto        # auto | native | brave | tavily | duckduckgo
learner:
  notes: ""             # how you learn best; added to the teacher's instructions
`;
