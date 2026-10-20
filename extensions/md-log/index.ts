import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// md-log: mirror the session into a markdown file you read rendered (Obsidian or any viewer),
// where math, code and diagrams display properly. Append-only: it never rewrites the file.
//
//   /md-log <file>   link an existing markdown file (offers to append the session so far)
//   /md-unlog        stop

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

function callout(type: string, title: string, body: string[]): string {
	return [`> [!${type}] ${title}`, ...body.map((l) => (l ? `> ${l}` : ">"))].join("\n");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: { type: string }) => c.type === "text")
		.map((c: { text: string }) => c.text)
		.join("\n");
}

function stripSkillBlocks(text: string): string {
	return text.replace(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g, (_m, attrs: string) => `> [!note] Skill loaded: ${/name="([^"]+)"/.exec(attrs)?.[1] ?? "?"}`);
}

function qaBlock(toolName: string, args: any, details: any): string[] {
	const options: { label: string }[] = details?.options ?? (Array.isArray(args?.options) ? args.options : []);
	const q = [String(args?.question ?? ""), ...(args?.details ? ["", String(args.details)] : []), "", ...options.map((o, i) => `${i + 1}. ${o.label}`)];
	const blocks = [callout("question", toolName === "quiz" ? "Quiz" : "Question", q)];
	if (!details || details.status !== "answered") {
		blocks.push(callout("warning", "Skipped", [""]));
		return blocks;
	}
	if (toolName === "quiz") {
		const verdict = details.dontKnow ? "I don't know" : details.correct ? "correct ✓" : "incorrect ✗";
		const type = details.dontKnow ? "question" : details.correct ? "success" : "failure";
		const body = [
			details.dontKnow ? "Your answer: I don't know" : `Your answer: ${(details.selected ?? []).join(", ")}`,
			`Correct answer: ${(details.correctIndices ?? []).join(", ")}`,
			...(details.note ? [`Note: ${details.note}`] : []),
			...(details.explanation ? ["", ...String(details.explanation).split("\n")] : []),
		];
		blocks.push(callout(type, `Quiz: ${verdict}`, body));
	} else {
		blocks.push(callout("example", "Answer", [details.other ? `Other: ${details.other}` : (details.answers ?? []).join("; "), ...(details.note ? [`Note: ${details.note}`] : [])]));
	}
	return blocks;
}

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;
	let queue: Promise<void> = Promise.resolve();

	const append = (text: string) => {
		const file = logFile;
		if (!file) return;
		queue = queue.then(() => {
			try {
				const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
				fs.appendFileSync(file, `${size > 0 ? "\n\n" : ""}${text}\n`, "utf8");
			} catch {
				// The file may have been moved or deleted; logging is best-effort.
			}
		});
	};

	const setStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("md-log", logFile ? ctx.ui.theme.fg("dim", `🗒 ${path.basename(logFile)}`) : undefined);
	};

	pi.on("session_start", async (_e, ctx) => {
		logFile = null;
		for (const entry of ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: { file: string | null } }>) {
			if (entry.type === "custom" && entry.customType === "md-log") logFile = entry.data?.file ?? null;
		}
		setStatus(ctx);
	});

	pi.on("message_end", async (event) => {
		const m = event.message as { role: string; content?: unknown; customType?: string; display?: boolean };
		if (m.role === "user") {
			const t = stripSkillBlocks(textOf(m.content).trim());
			if (t) append(`> [!quote] YOU\n\n${t}`);
		} else if (m.role === "assistant") {
			const t = textOf(m.content).trim();
			if (t) append(`> [!abstract] TEACHER\n\n${t}`);
		} else if (m.role === "custom" && m.customType === "learn-lesson-start") {
			append(`---\n\n## ${(m as { details?: { title?: string } }).details?.title ?? "Lesson"}`);
		}
	});

	pi.on("tool_result", async (event) => {
		if (QA_TOOLS.has(event.toolName)) for (const b of qaBlock(event.toolName, event.input, event.details)) append(b);
		if (event.toolName === "visualize") {
			const file = (event.details as { file?: string } | undefined)?.file;
			if (file) append(`![[${path.basename(file)}|600]]`);
		}
	});

	// Gate prompts and results are transcript notes from the learn extension.
	pi.events.on("learn:note", (data: unknown) => {
		const d = data as { text: string; level: string };
		append(callout(d.level === "success" ? "success" : d.level === "warning" || d.level === "error" ? "warning" : "info", "", d.text.split("\n")));
	});

	pi.registerCommand("md-log", {
		description: "Mirror this session into a markdown file (append-only)",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) return ctx.ui.notify("Usage: /md-log <file.md>", "warning");
			const file = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
			if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return ctx.ui.notify(`Not an existing file: ${file}. Create it first.`, "error");
			await ctx.waitForIdle();
			logFile = file;
			pi.appendEntry("md-log", { file });
			setStatus(ctx);
			const branch = ctx.sessionManager.getBranch() as Array<{ type: string; message?: any }>;
			const hasHistory = branch.some((e) => e.type === "message");
			const backfill = hasHistory && (fs.statSync(file).size === 0 || (await ctx.ui.confirm("Append this session's history to the file?", "Existing content is kept; history goes below it.")));
			if (backfill) {
				const args = new Map<string, any>();
				for (const e of branch) {
					const m = e.message;
					if (e.type !== "message" || !m) continue;
					if (m.role === "assistant") for (const c of m.content ?? []) if (c.type === "toolCall") args.set(c.id, c.arguments);
					if (m.role === "user") {
						const t = stripSkillBlocks(textOf(m.content).trim());
						if (t) append(`> [!quote] YOU\n\n${t}`);
					} else if (m.role === "assistant") {
						const t = textOf(m.content).trim();
						if (t) append(`> [!abstract] TEACHER\n\n${t}`);
					} else if (m.role === "toolResult" && QA_TOOLS.has(m.toolName)) {
						for (const b of qaBlock(m.toolName, args.get(m.toolCallId), m.details)) append(b);
					}
				}
			}
			ctx.ui.notify(`Logging to ${path.relative(ctx.cwd, file) || file}`, "info");
		},
	});

	pi.registerCommand("md-unlog", {
		description: "Stop mirroring the session to markdown",
		handler: async (_args, ctx) => {
			logFile = null;
			pi.appendEntry("md-log", { file: null });
			setStatus(ctx);
			ctx.ui.notify("md-log stopped", "info");
		},
	});
}
