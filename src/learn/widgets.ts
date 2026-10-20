import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { activity, formatElapsed, formatTokens, type RunRecord } from "../agents/activity.ts";
import { progressLine } from "../map/render.ts";
import type { ThemeLike } from "../ui/text.ts";
import type { LearnRuntime } from "./runtime.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LINGER_DONE_MS = 4000;
const LINGER_FAILED_MS = 15000;

function shortModel(model: string): string {
	return model.slice(model.indexOf("/") + 1);
}

/** Live lines for running subagents; finished runs linger briefly so completion is visible too. */
class ActivityWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: ThemeLike;
	private readonly unsubscribe: () => void;
	private timer: ReturnType<typeof setInterval> | undefined;
	private frame = 0;

	constructor(tui: TUI, theme: ThemeLike) {
		this.tui = tui;
		this.theme = theme;
		this.unsubscribe = activity.subscribe(() => this.sync());
		this.sync();
	}

	private visible(): RunRecord[] {
		const now = Date.now();
		return activity.recent().filter((r) => {
			if (r.status === "running") return true;
			const linger = r.status === "done" ? LINGER_DONE_MS : LINGER_FAILED_MS;
			return r.endedAt !== undefined && now - r.endedAt < linger;
		});
	}

	private sync(): void {
		const active = this.visible().length > 0;
		if (active && !this.timer) {
			this.timer = setInterval(() => {
				this.frame = (this.frame + 1) % SPINNER.length;
				if (this.visible().length === 0) this.sync();
				this.tui.requestRender();
			}, 120);
		} else if (!active && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		return this.visible()
			.reverse()
			.map((r) => {
				const end = r.endedAt ?? Date.now();
				const icon =
					r.status === "running"
						? t.fg("accent", SPINNER[this.frame]!)
						: r.status === "done"
							? t.fg("success", "✓")
							: t.fg("error", "✗");
				const meta = t.fg("dim", ` · ${shortModel(r.model)} · ${formatElapsed(end - r.startedAt)} · ${formatTokens(r.tokens)} tok`);
				const step = r.status === "failed" ? t.fg("error", ` · ${r.error ?? "failed"}`) : r.status === "running" ? t.fg("muted", ` · ${r.step}`) : "";
				return truncateToWidth(`${icon} ${t.fg("text", r.role)} ${t.fg("muted", r.label)}${meta}${step}`, width);
			});
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
		if (this.timer) clearInterval(this.timer);
	}
}

export function installActivityWidget(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget("learn-activity", (tui, theme) => new ActivityWidget(tui, theme as unknown as ThemeLike), { placement: "aboveEditor" });
}

/** Topic and lesson progress above the editor. Cleared when there is no active topic. */
export function refreshProgressWidget(rt: LearnRuntime, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const topic = rt.activeTopic();
	if (!topic || topic.status === "planning") {
		ctx.ui.setWidget("learn-progress", undefined);
		ctx.ui.setStatus("learn", undefined);
		return;
	}
	const t = ctx.ui.theme;
	const nodes = rt.store.loadNodes();
	const lines = [t.fg("accent", "📚 ") + t.bold(topic.title) + t.fg("muted", ` · ${progressLine(topic, nodes)}`)];
	const lesson = topic.lesson;
	const node = lesson ? nodes.get(lesson.node) : undefined;
	if (lesson && node) {
		const beats = node.outline.length;
		const done = lesson.beats_done.length;
		const budget = beats * rt.config.lesson.turns_per_beat;
		const parts = [
			t.fg("accent", "◐ ") + t.fg("text", node.title),
			t.fg("muted", `beat ${Math.min(done + 1, beats)}/${beats}`),
			lesson.turns > budget ? t.fg("warning", `turns ${lesson.turns}/${budget} (over budget)`) : t.fg("dim", `turns ${lesson.turns}/${budget}`),
		];
		if (done >= beats) parts.push(t.fg("success", "Gate ready (/gate)"));
		lines.push(parts.join(t.fg("dim", " · ")));
	}
	const run = rt.gateRun;
	if (run?.awaiting) {
		const what =
			run.awaiting.kind === "code"
				? "edit your solution, then send any message to run the tests"
				: run.awaiting.kind === "follow_up"
					? "your next message answers the follow-up"
					: "your next message is graded";
		lines.push(t.fg("warning", `✎ Gate check ${run.index + 1}/${run.checkIds.length}: ${what} · /gate cancel to go back`));
	}
	ctx.ui.setWidget("learn-progress", lines, { placement: "aboveEditor" });
	ctx.ui.setStatus("learn", t.fg("dim", `📚 ${topic.slug}`));
}
