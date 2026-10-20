import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { showChoice } from "../../src/ui/choice.ts";

// Graded and ungraded questions for the teacher. `quiz` has a right answer and grades it on the
// spot; `ask_user_question` collects a preference or decision. Both share one dialog component
// and one UI lock with the rest of the package.

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label." }),
	value: Type.Optional(Type.String({ description: "Stable machine value; defaults to the label." })),
	description: Type.Optional(Type.String({ description: "Extra detail shown under the option." })),
});

export interface QuizDetails {
	status: "answered" | "cancelled" | "unavailable";
	question: string;
	options?: { index: number; label: string }[];
	selected?: number[];
	correctIndices?: number[];
	correct?: boolean;
	dontKnow?: boolean;
	note?: string;
	explanation?: string;
	message?: string;
}

export interface AskDetails {
	status: "answered" | "cancelled" | "unavailable";
	question: string;
	options?: { index: number; label: string }[];
	answers?: string[];
	other?: string;
	note?: string;
}

function shuffle<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

function normalize(options: { label: string; value?: string; description?: string }[]) {
	const seen = new Set<string>();
	return options
		.map((o) => ({ label: o.label.trim(), value: (o.value ?? o.label).trim(), description: o.description?.trim() || undefined }))
		.filter((o) => {
			if (!o.label) return false;
			if (seen.has(o.value)) throw new Error(`duplicate option value "${o.value}"`);
			seen.add(o.value);
			return true;
		});
}

/** Accept a JSON-stringified array, which some models send for multi-select answers. */
function coerceAnswer(answer: string | string[]): string[] {
	if (Array.isArray(answer)) return answer;
	const t = answer.trim();
	if (t.startsWith("[") && t.endsWith("]")) {
		try {
			const parsed = JSON.parse(t);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			// fall through: a literal value that happens to look like JSON
		}
	}
	return [answer];
}

export default function questions(pi: ExtensionAPI) {
	pi.registerTool({
		name: "quiz",
		label: "quiz",
		description:
			"Ask the learner a GRADED multiple-choice question with a known correct answer. The answer is graded instantly and the learner sees ✓/✗, the correct answer, and your explanation. An 'I don't know' choice and an optional note field are added automatically. For questions with no right answer, use ask_user_question.",
		promptSnippet: "quiz: ask a graded multiple-choice question (correct answer + explanation required).",
		promptGuidelines: [
			"quiz is graded; ask_user_question is not. If a question has a right answer, use quiz.",
			"correctAnswer is the option `value` (or an array of values for multiSelect), never a position.",
			"Every option is a bare claim with no reasoning inside it; put all reasoning in `explanation`. Write the correct claim first, then turn it into each distractor by applying one specific misconception, keeping the same structure and length.",
			"Never add your own 'I don't know' / 'not sure' option.",
			"A dontKnow result is an honest knowledge gap, not a wrong guess: teach into it.",
			"Read the learner's note when present; it shows what they were thinking.",
			"Options are shuffled; set shuffle: false only when order matters.",
		],
		parameters: Type.Object({
			question: Type.String(),
			details: Type.Optional(Type.String({ description: "Extra context shown under the question." })),
			options: Type.Array(OptionSchema, { minItems: 2 }),
			multiSelect: Type.Optional(Type.Boolean()),
			correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())]),
			explanation: Type.String({ description: "Why the answer is right; revealed after answering." }),
			shuffle: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: message }],
				details: { status: "unavailable", question: params.question, message } as QuizDetails,
			});
			let options;
			try {
				options = normalize(params.options);
			} catch (e) {
				return fail(`quiz: ${(e as Error).message}`);
			}
			if (options.length < 2) return fail("quiz: needs at least two options");
			if (params.shuffle !== false) options = shuffle(options);
			const byValue = new Map(options.map((o, i) => [o.value, i]));
			const correctIndices: number[] = [];
			for (const v of coerceAnswer(params.correctAnswer)) {
				const idx = byValue.get(v.trim());
				if (idx === undefined) return fail(`quiz: correctAnswer "${v}" matches no option value (${[...byValue.keys()].join(", ")})`);
				correctIndices.push(idx);
			}
			if (!ctx.hasUI) return fail("quiz: needs an interactive UI");
			const displayed = options.map((o, i) => ({ index: i + 1, label: o.label }));
			// Publish the real display order before blocking, so listeners (md-log) match the screen.
			onUpdate?.({ content: [{ type: "text", text: "Waiting for the learner…" }], details: { status: "answered", question: params.question, options: displayed } as QuizDetails });

			const correctSet = new Set(correctIndices);
			const answer = await showChoice(ctx, {
				title: "Quiz",
				question: params.question,
				details: params.details,
				options: options.map((o) => ({ label: o.label, description: o.description })),
				multi: params.multiSelect,
				allowDontKnow: true,
				allowNote: true,
				feedback: (a) => {
					const right =
						a.kind === "options" && a.selected.length === correctSet.size && a.selected.every((i) => correctSet.has(i));
					return {
						correct: correctIndices,
						verdict: a.kind === "dont_know" ? "dont_know" : right ? "correct" : "incorrect",
						lines: [params.explanation],
					};
				},
			});
			if (!answer) {
				return { content: [{ type: "text", text: "The learner skipped the question." }], details: { status: "cancelled", question: params.question } as QuizDetails };
			}
			const selected = answer.kind === "options" ? answer.selected : [];
			const dontKnow = answer.kind === "dont_know";
			const correct = !dontKnow && selected.length === correctSet.size && selected.every((i) => correctSet.has(i));
			const fmt = (i: number) => `${i + 1}. ${options[i]!.label}`;
			let text = dontKnow
				? `The learner chose "I don't know": an honest gap, not a guess.`
				: `The learner answered ${correct ? "correctly" : "incorrectly"}. Selected: ${selected.map(fmt).join(", ")}.`;
			text += `\nCorrect: ${correctIndices.map(fmt).join(", ")}.`;
			if (answer.note) text += `\nLearner's note: ${answer.note}`;
			return {
				content: [{ type: "text", text }],
				details: {
					status: "answered",
					question: params.question,
					options: displayed,
					selected: selected.map((i) => i + 1),
					correctIndices: correctIndices.map((i) => i + 1),
					correct,
					dontKnow,
					note: answer.note,
					explanation: params.explanation,
				} as QuizDetails,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("quiz ")) + theme.fg("muted", args.question ?? ""), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as QuizDetails | undefined;
			if (!d || d.status !== "answered" || d.correct === undefined) {
				const first = result.content[0];
				return new Text(theme.fg("warning", first?.type === "text" ? first.text : ""), 0, 0);
			}
			const correct = new Set(d.correctIndices);
			const selected = new Set(d.selected);
			const lines = (d.options ?? []).map((o) => {
				const key = correct.has(o.index);
				const sel = selected.has(o.index);
				const mark = key ? theme.fg("success", "✓ ") : sel && !d.dontKnow ? theme.fg("error", "✗ ") : "  ";
				const color = key ? "success" : sel && !d.dontKnow ? "error" : "dim";
				return mark + theme.fg(color, `${o.index}. ${o.label}`);
			});
			lines.push(d.dontKnow ? theme.fg("warning", "I don't know") : d.correct ? theme.fg("success", "Correct") : theme.fg("error", "Incorrect"));
			if (d.note) lines.push(theme.fg("muted", `Note: ${d.note}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "ask_user_question",
		label: "ask",
		description:
			"Ask the learner a question with NO right answer (a preference, a decision, what they want next), with options and an 'Other' free-text choice. For questions with a right answer, use quiz.",
		promptSnippet: "ask_user_question: ask the learner an ungraded question (preference, direction).",
		parameters: Type.Object({
			question: Type.String(),
			details: Type.Optional(Type.String()),
			options: Type.Array(OptionSchema, { minItems: 1 }),
			multiSelect: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const options = normalize(params.options);
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "ask_user_question needs an interactive UI." }], details: { status: "unavailable", question: params.question } as AskDetails };
			}
			const answer = await showChoice(ctx, {
				title: "Question",
				question: params.question,
				details: params.details,
				options: options.map((o) => ({ label: o.label, description: o.description })),
				multi: params.multiSelect,
				allowOther: true,
				allowNote: true,
			});
			const displayed = options.map((o, i) => ({ index: i + 1, label: o.label }));
			if (!answer || answer.kind === "dont_know") {
				return { content: [{ type: "text", text: "The learner skipped the question." }], details: { status: "cancelled", question: params.question, options: displayed } as AskDetails };
			}
			const answers = answer.kind === "options" ? answer.selected.map((i) => options[i]!.label) : [];
			const other = answer.kind === "other" ? answer.text : undefined;
			let text = other ? `The learner wrote: ${other}` : `The learner chose: ${answers.join("; ")}`;
			if (answer.note) text += `\nLearner's note: ${answer.note}`;
			return { content: [{ type: "text", text }], details: { status: "answered", question: params.question, options: displayed, answers, other, note: answer.note } as AskDetails };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", args.question ?? ""), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as AskDetails | undefined;
			if (!d || d.status !== "answered") return new Text(theme.fg("warning", "skipped"), 0, 0);
			const text = d.other ? `Other: ${d.other}` : (d.answers ?? []).join("; ");
			return new Text(theme.fg("accent", text) + (d.note ? `\n${theme.fg("muted", `Note: ${d.note}`)}` : ""), 0, 0);
		},
	});
}
