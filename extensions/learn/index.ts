import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Markdown, Text } from "@earendil-works/pi-tui";
import { activity, formatElapsed, formatTokens } from "../../src/agents/activity.ts";
import { runAgent } from "../../src/agents/runner.ts";
import { RepeatSchema } from "../../src/agents/schemas.ts";
import { EXAMPLE_CONFIG, projectConfigPath } from "../../src/config.ts";
import { findJev, gradeFree } from "../../src/gate/free-grader.ts";
import { nextNode } from "../../src/graph/graph.ts";
import { buildBrief, closeNode, currentBeat, LESSON_START, startLesson } from "../../src/learn/lesson.ts";
import { cancelGate, handleGateAnswer, startGate } from "../../src/learn/gate.ts";
import { planTopic } from "../../src/learn/planning.ts";
import { LearnRuntime } from "../../src/learn/runtime.ts";
import { registerTeacherTools, unplace } from "../../src/learn/tools.ts";
import { installActivityWidget, refreshProgressWidget } from "../../src/learn/widgets.ts";
import { writeGraphPage } from "../../src/map/graph-page.ts";
import { mapLines, progressLine } from "../../src/map/render.ts";
import type { FreeCheck } from "../../src/types.ts";
import { terminalLatexInMarkdown } from "../../src/ui/latex.ts";
import { showPager } from "../../src/ui/pager.ts";
import { wrapLines } from "../../src/ui/text.ts";

const TEACHER_TOOLS = ["beat_done", "park", "view_rubric", "offer_gate", "propose_pass", "propose_unplace", "research", "visualize"];

/** Open a file with the desktop's default app. False when there is no desktop to open it on (e.g. over SSH). */
function openFile(file: string): boolean {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
	try {
		const child = spawn(cmd, [file], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

export default function learn(pi: ExtensionAPI) {
	const rt = new LearnRuntime(pi);
	registerTeacherTools(pi, rt);

	/** Teacher tools are declared to the model only while a lesson is running. */
	function syncTools(): void {
		const active = new Set(pi.getActiveTools());
		const inLesson = rt.activeLesson() !== undefined;
		for (const t of TEACHER_TOOLS) {
			if (inLesson) active.add(t);
			else active.delete(t);
		}
		pi.setActiveTools([...active]);
	}

	function refresh(ctx: ExtensionContext): void {
		syncTools();
		refreshProgressWidget(rt, ctx);
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		rt.cwd = ctx.cwd;
		rt.gateRun = undefined;
		rt.pendingGate = undefined;
		installActivityWidget(ctx);
		refresh(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const lesson = rt.activeLesson();
		if (!lesson) return;
		syncTools();
		if (event.messageType === "user") {
			lesson.topic.lesson!.turns++;
			rt.store.saveTopic(lesson.topic);
			refreshProgressWidget(rt, ctx);
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${buildBrief(rt, lesson.topic, lesson.node)}` };
	});

	// Each lesson starts from a clean context: drop everything before the latest lesson start.
	// The whole transcript stays in the session file; only what the model sees is trimmed.
	pi.on("context", async (event) => {
		if (!rt.activeLesson()) return;
		const idx = event.messages.findLastIndex((m) => (m as { role: string; customType?: string }).role === "custom" && (m as { customType?: string }).customType === LESSON_START);
		if (idx > 0) return { messages: event.messages.slice(idx) };
	});

	pi.on("input", async (event, ctx) => {
		if (!rt.gateRun?.awaiting || event.text.trim().startsWith("/")) return;
		void handleGateAnswer(rt, ctx, event.text).catch((e) => rt.note(`Gate error: ${(e as Error).message}`, "error"));
		return { action: "handled" };
	});

	pi.on("agent_settled", async (event, ctx) => {
		const pending = rt.pendingGate;
		rt.pendingGate = undefined;
		if (pending && !event.aborted) {
			const node = rt.store.getNode(pending);
			if (node) void startGate(rt, ctx, node).catch((e) => rt.note(`Gate error: ${(e as Error).message}`, "error"));
		}
		refresh(ctx);
	});

	// ── Practice-question limits ─────────────────────────────────────────────

	async function isRepeat(ctx: ExtensionContext, question: string, previous: string[]): Promise<string | undefined> {
		const jev = findJev(ctx.modelRegistry);
		if (jev) {
			const r = await ctx.modelRegistry.classify(jev, {
				state: { new_question: question, previous },
				questions: {
					repeat: {
						type: "bool",
						instructions:
							"Does `new_question` ask for essentially the same knowledge as any question in `previous` (reworded, reordered, or reframed), rather than a different point or a meaningfully new application?",
						criteria: { true: "It repeats an earlier question", false: "It tests something new" },
					},
				},
			});
			const a = r.answers.repeat;
			if (r.stopReason === "stop" && a?.type === "bool") return a.probability >= 0.6 ? previous.at(-1) : undefined;
		}
		const { output } = await runAgent(rt.agentEnv(ctx), {
			role: "summarizer",
			prompt: "repeat-checker",
			label: "checking for a repeated question",
			task: `New question:\n${question}\n\nAlready answered correctly:\n${previous.map((p) => `- ${p}`).join("\n")}`,
			output: RepeatSchema,
		});
		return output?.same ? (output.matches ?? previous.at(-1)) : undefined;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "quiz" && event.toolName !== "ask_user_question") return;
		const lesson = rt.activeLesson();
		const lp = lesson?.topic.lesson;
		if (!lesson || !lp) return;
		if (rt.gateRun) return { block: true, reason: "A gate is in progress; wait for it to finish." };
		const beat = currentBeat(lesson.node, lp);
		const used = lp.practice[String(beat)] ?? 0;
		const cap = rt.config.gate.practice_per_beat;
		if (used >= cap) {
			return {
				block: true,
				reason: `Practice budget for this beat is used up (${used}/${cap}). If the beat has landed, call beat_done; otherwise explain it differently instead of asking again.`,
			};
		}
		const question = String((event.input as { question?: unknown }).question ?? "");
		if (event.toolName === "quiz" && lp.practice_correct.length > 0) {
			try {
				const dup = await isRepeat(ctx, question, lp.practice_correct);
				if (dup) return { block: true, reason: `The learner already answered essentially this correctly ("${dup}"). Don't re-ask it in other words: move on.` };
			} catch {
				// The repeat check is a guard, not a gate: if it fails, let the question through.
			}
		}
		lp.practice[String(beat)] = used + 1;
		rt.store.saveTopic(lesson.topic);
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "quiz") return;
		const lesson = rt.activeLesson();
		const lp = lesson?.topic.lesson;
		if (!lesson || !lp) return;
		const d = event.details as { correct?: boolean; dontKnow?: boolean; question?: string } | undefined;
		if (!d || d.correct === undefined) return;
		if (d.correct && d.question) lp.practice_correct.push(d.question);
		rt.store.saveTopic(lesson.topic);
		rt.store.appendEvidence({ kind: "practice", node: lesson.node.id, topic: lesson.topic.slug, data: { question: d.question, correct: d.correct, dont_know: d.dontKnow } });
	});

	// ── Rendering ────────────────────────────────────────────────────────────

	// pi-math draws math as MathJax images (inline ones only over the kitty protocol); it handles
	// multi-letter accents and \boxed itself, so only rewrite those for pi's text renderer.
	let piMathLoaded: boolean | undefined;
	pi.on("session_start", () => {
		piMathLoaded = undefined;
	});
	const piMathDraws = () => getCapabilities().images === "kitty" && (piMathLoaded ??= pi.getCommands().some((c) => c.name === "math-render"));
	pi.registerMarkdownTransformer((markdown) => terminalLatexInMarkdown(markdown, !piMathDraws()));

	pi.registerEntryRenderer<{ text: string; level: string }>("learn-note", (entry, _opts, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		const color = d.level === "success" ? "success" : d.level === "warning" ? "warning" : d.level === "error" ? "error" : "accent";
		const md = new Markdown(d.text, 1, 0, getMarkdownTheme());
		const bar = theme.fg(color, "▌");
		return {
			render: (w: number) => md.render(w - 2).map((l) => `${bar} ${l}`),
			invalidate: () => md.invalidate(),
		};
	});

	pi.registerMessageRenderer<{ title?: string; resuming?: boolean }>(LESSON_START, (msg, _opts, theme) => {
		const title = msg.details?.title ?? "";
		return new Text(theme.fg("accent", theme.bold(`━━ ${msg.details?.resuming ? "Resuming" : "Lesson"}: ${title} `)) + theme.fg("accent", "━".repeat(20)), 0, 1);
	});

	pi.registerMessageRenderer("learn-gate-result", (msg, opts, theme) => {
		const text = typeof msg.content === "string" ? msg.content : "";
		const head = theme.fg("warning", "▌ ") + theme.fg("warning", text.split("\n")[0] ?? "");
		return new Text(opts.expanded ? `${head}\n${theme.fg("dim", text.split("\n").slice(1).join("\n"))}` : head, 0, 0);
	});

	// ── Commands ─────────────────────────────────────────────────────────────

	async function resume(ctx: ExtensionContext & { waitForIdle(): Promise<void> }): Promise<void> {
		await ctx.waitForIdle();
		const topic = rt.activeTopic();
		if (!topic) return;
		const nodes = rt.recompute();
		const node = topic.lesson ? nodes.get(topic.lesson.node) : nextNode(topic, nodes);
		if (!node) {
			rt.note(topic.status === "done" ? `**${topic.title}** is complete.` : "Nothing is ready to learn in this topic. See /map.");
			return refresh(ctx);
		}
		await startLesson(rt, ctx, topic, node);
		syncTools();
	}

	pi.registerCommand("learn", {
		description: "Learn something: /learn <what you want to learn>, or /learn to continue",
		getArgumentCompletions: (prefix) =>
			rt.store
				.listTopics()
				.filter((t) => t.slug.startsWith(prefix))
				.map((t) => ({ value: t.slug, label: t.slug, description: t.title })),
		handler: async (args, ctx) => {
			rt.cwd = ctx.cwd;
			const request = args.trim();
			const topics = rt.store.listTopics();
			const match = topics.find((t) => t.slug === request);
			if (match) {
				rt.setActiveTopic(match.slug);
				return resume(ctx);
			}
			if (request) {
				await ctx.waitForIdle();
				await planTopic(rt, ctx, request);
				return refresh(ctx);
			}
			if (rt.activeTopic()) return resume(ctx);
			if (topics.length > 0) {
				const pick = await ctx.ui.select("Continue which topic?", [...topics.map((t) => `${t.slug}: ${t.title}`), "Something new…"]);
				if (!pick) return;
				if (pick !== "Something new…") {
					rt.setActiveTopic(pick.slice(0, pick.indexOf(":")));
					return resume(ctx);
				}
			}
			const what = await ctx.ui.input("What do you want to learn?", "e.g. inverse kinematics for robot arms");
			if (what?.trim()) {
				await planTopic(rt, ctx, what.trim());
				refresh(ctx);
			}
		},
	});

	pi.registerCommand("gate", {
		description: "Take the current node's gate (or test out of a ready node); /gate cancel stops it",
		handler: async (args, ctx) => {
			if (args.trim() === "cancel") return cancelGate(rt, ctx);
			if (rt.gateRun) return ctx.ui.notify("A gate is already in progress. /gate cancel stops it.", "warning");
			await ctx.waitForIdle();
			const lesson = rt.activeLesson();
			if (lesson) return startGate(rt, ctx, lesson.node);
			const topic = rt.activeTopic();
			if (!topic) return ctx.ui.notify("No active topic. Start one with /learn.", "info");
			const nodes = rt.recompute();
			const ready = topic.nodes.map((id) => nodes.get(id)!).filter((n) => n?.state === "ready");
			if (ready.length === 0) return ctx.ui.notify("No node is ready to test out of.", "info");
			const pick = await ctx.ui.select("Test out of which node?", ready.map((n) => n.title));
			const node = ready.find((n) => n.title === pick);
			if (node) await startGate(rt, ctx, node);
		},
	});

	pi.registerCommand("pass", {
		description: "Close the current gate (or one check) yourself; recorded as an override",
		handler: async (_args, ctx) => {
			const lesson = rt.activeLesson();
			const lp = lesson?.topic.lesson;
			if (!lesson || !lp) return ctx.ui.notify("No lesson in progress.", "info");
			const gate = rt.store.getGate(lesson.node.id);
			const open = gate?.checks.filter((c) => !lp.gate.passed_checks.includes(c.id)) ?? [];
			const options = ["The whole gate", ...open.map((c) => `${c.id}: ${c.prompt.slice(0, 70)}`)];
			const pick = await ctx.ui.select(`Close what for "${lesson.node.title}"?`, options);
			if (!pick) return;
			if (rt.gateRun) cancelGate(rt, ctx);
			if (pick === "The whole gate") {
				rt.store.appendEvidence({ kind: "override", node: lesson.node.id, topic: lesson.topic.slug, data: { by: "learner", scope: "gate" } });
				return closeNode(rt, ctx, lesson.node.id, "override");
			}
			const id = pick.slice(0, pick.indexOf(":"));
			lp.gate.passed_checks.push(id);
			rt.store.saveTopic(lesson.topic);
			rt.store.appendEvidence({ kind: "override", node: lesson.node.id, topic: lesson.topic.slug, data: { by: "learner", check: id } });
			if (gate!.checks.every((c) => lp.gate.passed_checks.includes(c.id))) return closeNode(rt, ctx, lesson.node.id, "override");
			rt.note(`Check ${id} closed by you. ${open.length - 1} check(s) left.`);
		},
	});

	pi.registerCommand("dispute", {
		description: "Disagree with the last free-answer grade; a second grader re-reads it with your argument",
		handler: async (_args, ctx) => {
			const last = rt.lastFailedFree;
			const lesson = rt.activeLesson();
			if (!last || !lesson || lesson.node.id !== last.node) return ctx.ui.notify("There's no failed answer to dispute in this lesson.", "info");
			const check = rt.store.getGate(last.node)?.checks.find((c) => c.id === last.checkId) as FreeCheck | undefined;
			if (!check) return;
			const argument = await ctx.ui.editor("Why is your answer right? (the grader reads this with your answer)", "");
			if (!argument?.trim()) return;
			const verdict = await gradeFree(rt.agentEnv(ctx), check, { answer: last.answer, argument }, true);
			rt.store.appendEvidence({ kind: "dispute", node: last.node, topic: lesson.topic.slug, data: { check: check.id, argument, upheld: verdict.outcome === "pass" } });
			rt.lastFailedFree = undefined;
			if (verdict.outcome !== "pass") {
				rt.note(`The second grader agrees your answer is missing: ${verdict.missed.join("; ")}. The rubric stays as it is; /pass is there if you still disagree.`, "warning");
				return;
			}
			const lp = lesson.topic.lesson!;
			if (!lp.gate.passed_checks.includes(check.id)) lp.gate.passed_checks.push(check.id);
			if (lp.gate.attempts[check.id]) lp.gate.attempts[check.id]!--;
			rt.store.saveTopic(lesson.topic);
			rt.note(`Dispute upheld: check ${check.id} counts as passed.`, "success");
			const gate = rt.store.getGate(lesson.node.id)!;
			if (gate.checks.every((c) => lp.gate.passed_checks.includes(c.id))) await closeNode(rt, ctx, lesson.node.id, "pass");
		},
	});

	pi.registerCommand("map", {
		description: "Show a topic's knowledge map and progress (/map graph opens the dependency graph in a browser)",
		getArgumentCompletions: (prefix) =>
			[{ value: "graph", label: "graph", description: "Open the dependency graph in a browser" }, ...rt.store.listTopics().map((t) => ({ value: t.slug, label: t.slug }))].filter((c) =>
				c.value.startsWith(prefix),
			),
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const graph = words[0] === "graph";
			const slug = graph ? words[1] : words[0];
			const topic = slug ? rt.store.getTopic(slug) : rt.activeTopic();
			if (!topic) return ctx.ui.notify("No topic. Start one with /learn.", "info");
			const nodes = rt.recompute();
			if (!graph) return showPager(ctx, `Map: ${topic.title}`, (w) => mapLines(topic, nodes, ctx.ui.theme).flatMap((l) => wrapLines(l, w)));
			ctx.ui.setStatus("learn-graph", "Rendering the dependency graph…");
			try {
				const file = await writeGraphPage(rt.store.paths.maps, topic, nodes, rt.config.render.chrome);
				const opened = openFile(file);
				ctx.ui.notify(opened ? `Opened ${file}` : `Wrote ${file}; open it in a browser.`, "info");
			} catch (e) {
				ctx.ui.notify(`Couldn't render the graph: ${e instanceof Error ? e.message : String(e)}`, "error");
			} finally {
				ctx.ui.setStatus("learn-graph", undefined);
			}
		},
	});

	pi.registerCommand("topics", {
		description: "List your topics with progress and parked tangents",
		handler: async (_args, ctx) => {
			const topics = rt.store.listTopics();
			if (topics.length === 0) return ctx.ui.notify("No topics yet. Start one with /learn.", "info");
			const nodes = rt.recompute();
			const active = rt.activeTopic()?.slug;
			const t = ctx.ui.theme;
			await showPager(ctx, "Topics", (w) =>
				topics.flatMap((topic) => [
					(topic.slug === active ? t.fg("accent", "▶ ") : "  ") + t.bold(topic.title) + t.fg("dim", ` (${topic.slug}, ${topic.status})`),
					...wrapLines(t.fg("muted", topic.goal), w, "    "),
					t.fg("text", `    ${progressLine(topic, nodes)}`),
					...topic.backlog.map((b) => t.fg("dim", `    • parked: ${b.text}`)),
					"",
				]),
			);
		},
	});

	pi.registerCommand("lesson", {
		description: "Show what the teacher sees for the current lesson (outline, gate questions, status)",
		handler: async (_args, ctx) => {
			const lesson = rt.activeLesson();
			if (!lesson) return ctx.ui.notify("No lesson in progress.", "info");
			const brief = buildBrief(rt, lesson.topic, lesson.node);
			const visible = brief.slice(brief.indexOf("## Current lesson"));
			await showPager(ctx, `Lesson: ${lesson.node.title}`, (w) => wrapLines(visible, w));
		},
	});

	pi.registerCommand("agents", {
		description: "Show recent subagent runs and what each one did",
		handler: async (_args, ctx) => {
			const runs = activity.recent();
			if (runs.length === 0) return ctx.ui.notify("No subagent runs yet.", "info");
			const label = (r: (typeof runs)[number]) =>
				`${r.status === "running" ? "⠿" : r.status === "done" ? "✓" : "✗"} ${r.role}: ${r.label} · ${formatElapsed((r.endedAt ?? Date.now()) - r.startedAt)} · ${formatTokens(r.tokens)} tok · $${r.cost.toFixed(3)}`;
			const pick = await ctx.ui.select("Subagent runs", runs.map(label));
			const run = runs.find((r) => label(r) === pick);
			if (!run) return;
			const t = ctx.ui.theme;
			await showPager(ctx, `${run.role}: ${run.label}`, (w) => {
				const out = [t.fg("dim", `${run.model} · ${run.status}${run.error ? ` · ${run.error}` : ""} · ${run.toolCalls} tool calls`), ""];
				for (const m of run.messages as Array<{ role: string; content?: unknown; toolName?: string }>) {
					const parts = Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string; name?: string; arguments?: unknown }>) : [{ type: "text", text: String(m.content ?? "") }];
					for (const p of parts) {
						if (p.type === "text" && p.text?.trim()) {
							const who = m.role === "assistant" ? t.fg("accent", "agent") : m.role === "toolResult" ? t.fg("dim", `← ${m.toolName}`) : t.fg("muted", m.role);
							out.push(who);
							out.push(...wrapLines(m.role === "toolResult" ? t.fg("dim", p.text.slice(0, 1500)) : p.text, w, "  "));
						} else if (p.type === "toolCall") {
							out.push(t.fg("warning", `→ ${p.name} ${JSON.stringify(p.arguments).slice(0, 300)}`));
						} else if (p.type === "image") {
							out.push(t.fg("dim", "  [image]"));
						}
					}
				}
				return out;
			});
		},
	});

	pi.registerCommand("unplace", {
		description: "You don't actually know something marked as already known: learn it first",
		handler: async (_args, ctx) => {
			const topic = rt.activeTopic();
			if (!topic) return ctx.ui.notify("No active topic.", "info");
			const nodes = rt.store.loadNodes();
			const placed = topic.nodes.map((id) => nodes.get(id)).filter((n) => n?.state === "placed");
			if (placed.length === 0) return ctx.ui.notify("Nothing in this topic is marked as already known.", "info");
			const pick = await ctx.ui.select("Which one should you learn?", placed.map((n) => n!.title));
			const node = placed.find((n) => n!.title === pick);
			if (!node) return;
			await ctx.waitForIdle();
			if (rt.gateRun) cancelGate(rt, ctx);
			await unplace(rt, ctx, node.id);
			syncTools();
		},
	});

	pi.registerCommand("learn-config", {
		description: "Create .learn/config.yaml (models per role, grader, limits) if it doesn't exist",
		handler: async (_args, ctx) => {
			const file = projectConfigPath(ctx.cwd);
			if (!fs.existsSync(file)) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, EXAMPLE_CONFIG, "utf8");
			}
			ctx.ui.notify(`Config: ${path.relative(ctx.cwd, file)} (global defaults: ~/.pi/agent/learn.yaml)`, "info");
		},
	});
}
