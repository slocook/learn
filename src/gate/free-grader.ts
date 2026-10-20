import type { ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type AgentEnv, runAgent } from "../agents/runner.ts";
import { FreeGradeSchema } from "../agents/schemas.ts";
import type { Role } from "../config.ts";
import type { FreeCheck } from "../types.ts";
import { combineFreeVerdict, type FreeVerdict, type IdeaJudgment, statusFromProbability } from "./grade.ts";

export interface FreeAnswer {
	answer: string;
	/** Present when the learner is answering a clarifying follow-up. */
	followUp?: { question: string; answer: string };
	/** Present for /dispute: the learner's argument for why their answer is right. */
	argument?: string;
}

export function findJev(registry: ModelRegistry) {
	return registry.findOfType("classifier", "typesafe", "jev-latest");
}

/** One yes/no judgment per rubric idea, plus one per stated misconception. Undefined when Jev is unavailable. */
async function judgeWithJev(registry: ModelRegistry, check: FreeCheck, a: FreeAnswer, signal?: AbortSignal): Promise<IdeaJudgment[] | undefined> {
	const jev = findJev(registry);
	if (!jev) return undefined;
	const questions: Record<string, ClassifierQuestion> = {};
	check.rubric.forEach((idea, i) => {
		questions[`idea_${i}`] = {
			type: "bool",
			instructions:
				`Judged at everyday human-language precision, does the learner's answer (\`learner_answer\`, together with \`follow_up_answer\` if present) express the idea \`ideas[${i}].idea\`? ` +
				`Informal wording, synonyms, and loose-but-correct descriptions count; \`ideas[${i}].accept\` shows phrasings that count. Ignore spelling, grammar, and terminology. ` +
				"If the idea is already given in `question` itself, an answer that builds on it without restating it counts as expressing it.",
			criteria: { true: "The answer expresses this idea, in any wording", false: "The idea is absent from the answer" },
		};
		if (idea.reject_if) {
			questions[`reject_${i}`] = {
				type: "bool",
				instructions: `Does the learner's answer (\`learner_answer\`, with \`follow_up_answer\` if present) assert the misconception \`ideas[${i}].reject_if\`?`,
				criteria: { true: "The answer asserts this misconception", false: "It does not" },
			};
		}
	});
	const result = await registry.classify(
		jev,
		{
			state: {
				question: check.prompt,
				learner_answer: a.answer,
				...(a.followUp ? { follow_up_question: a.followUp.question, follow_up_answer: a.followUp.answer } : {}),
				ideas: check.rubric.map((r) => ({ idea: r.idea, accept: r.accept })),
			},
			questions,
		},
		{ signal },
	);
	if (result.stopReason !== "stop") return undefined;
	const prob = (key: string) => {
		const ans = result.answers[key];
		return ans?.type === "bool" ? ans.probability : undefined;
	};
	return check.rubric.map((_, i) => {
		const present = prob(`idea_${i}`);
		return { index: i, status: present === undefined ? "unclear" : statusFromProbability(present, prob(`reject_${i}`)) };
	});
}

function gradingTask(check: FreeCheck, a: FreeAnswer, onlyIdeas?: number[]): string {
	const ideas = check.rubric
		.map((r, i) => ({ r, i }))
		.filter(({ i }) => !onlyIdeas || onlyIdeas.includes(i))
		.map(({ r, i }) => {
			const accept = r.accept.length > 0 ? `\n   Counts: ${r.accept.map((x) => `"${x}"`).join(", ")}` : "";
			const reject = r.reject_if ? `\n   Fails only if: ${r.reject_if}` : "";
			return `${i}. ${r.idea}${accept}${reject}`;
		})
		.join("\n");
	let task = `## Question\n${check.prompt}\n\n## Rubric ideas (judge ${onlyIdeas ? "only these" : "each"})\n${ideas}\n\n## Learner's answer\n${a.answer}\n`;
	if (a.followUp) task += `\n## Clarifying follow-up\nQ: ${a.followUp.question}\nA: ${a.followUp.answer}\n`;
	if (a.argument) {
		task +=
			`\n## The learner disputes an earlier grade\n${a.argument}\n\n` +
			"Re-read the answer fairly in light of their argument. If a knowledgeable human would accept the answer, mark the ideas present.\n";
	}
	return task;
}

async function judgeWithLlm(
	env: AgentEnv,
	role: Role,
	check: FreeCheck,
	a: FreeAnswer,
	onlyIdeas?: number[],
): Promise<{ judgments: IdeaJudgment[]; followUp?: string }> {
	const { output } = await runAgent(env, {
		role,
		prompt: "grader",
		label: a.argument ? "dispute re-grade" : "grading your answer",
		task: gradingTask(check, a, onlyIdeas),
		output: FreeGradeSchema,
	});
	const judgments = (output?.ideas ?? []).filter((j) => j.index >= 0 && j.index < check.rubric.length);
	return { judgments, followUp: output?.follow_up };
}

/**
 * Grade a free-text answer. With Jev, each idea gets a calibrated yes/no; ideas Jev is unsure
 * about go to the LLM grader rather than failing. Disputes always use the teacher-tier model.
 */
export async function gradeFree(env: AgentEnv, check: FreeCheck, a: FreeAnswer, followUpUsed: boolean): Promise<FreeVerdict & { by: string }> {
	if (a.argument) {
		const { judgments } = await judgeWithLlm(env, "teacher", check, a);
		return { ...combineFreeVerdict(check, judgments, true), by: "dispute" };
	}
	let judgments: IdeaJudgment[] | undefined;
	let by = "llm";
	if (env.config.grader.backend === "jev") {
		try {
			judgments = await judgeWithJev(env.registry, check, a, env.signal);
			if (judgments) by = "jev";
		} catch {
			judgments = undefined;
		}
	}
	let followUp: string | undefined;
	if (!judgments) {
		({ judgments, followUp } = await judgeWithLlm(env, "grader", check, a));
	} else {
		const unclear = judgments.filter((j) => j.status === "unclear").map((j) => j.index);
		if (unclear.length > 0) {
			const llm = await judgeWithLlm(env, "grader", check, a, unclear);
			const byIndex = new Map(llm.judgments.map((j) => [j.index, j]));
			judgments = judgments.map((j) => (j.status === "unclear" ? (byIndex.get(j.index) ?? j) : j));
			followUp = llm.followUp;
			by = "jev+llm";
		}
	}
	return { ...combineFreeVerdict(check, judgments, followUpUsed, followUp), by };
}
