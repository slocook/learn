import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { mathText, type ThemeLike, wrapLines } from "./text.ts";

export interface ChoiceOption {
	label: string;
	description?: string;
}

export interface ChoiceRequest {
	/** Small header, e.g. "Quiz" or "Placement · Trigonometry (2/3)". */
	title: string;
	question: string;
	details?: string;
	options: ChoiceOption[];
	multi?: boolean;
	allowDontKnow?: boolean;
	allowOther?: boolean;
	allowNote?: boolean;
	/** When given, a feedback screen follows the answer until Enter/Esc. */
	feedback?: (answer: ChoiceAnswer) => ChoiceFeedback;
}

export interface ChoiceFeedback {
	/** Option indices to mark as correct (✓); selected-but-wrong ones get ✗. */
	correct: number[];
	verdict: "correct" | "incorrect" | "dont_know" | "info";
	lines: string[];
}

export type ChoiceAnswer =
	| { kind: "options"; selected: number[]; note?: string }
	| { kind: "other"; text: string; note?: string }
	| { kind: "dont_know"; note?: string };

type Row = { kind: "option"; index: number } | { kind: "submit" } | { kind: "dont_know" } | { kind: "other" };

class ChoiceComponent implements Component {
	private readonly req: ChoiceRequest;
	private readonly theme: ThemeLike;
	private readonly tui: TUI;
	private readonly done: (a: ChoiceAnswer | undefined) => void;
	private readonly rows: Row[];
	private cursor = 0;
	private readonly checked = new Set<number>();
	private mode: "select" | "other" | "note" | "feedback" = "select";
	private readonly otherInput = new Input({ placeholder: "Type your answer, Enter to submit, Esc to go back" });
	private readonly noteInput = new Input({ placeholder: "Optional note: what you're thinking or unsure about" });
	private answer: ChoiceAnswer | undefined;
	private feedback: ChoiceFeedback | undefined;

	constructor(req: ChoiceRequest, theme: ThemeLike, tui: TUI, done: (a: ChoiceAnswer | undefined) => void) {
		this.req = req;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.rows = req.options.map((_, index) => ({ kind: "option", index }) as Row);
		if (req.multi) this.rows.push({ kind: "submit" });
		if (req.allowOther) this.rows.push({ kind: "other" });
		if (req.allowDontKnow) this.rows.push({ kind: "dont_know" });
		this.otherInput.onSubmit = (v) => {
			if (v.trim()) this.finish({ kind: "other", text: v.trim(), note: this.note() });
		};
		this.otherInput.onEscape = () => this.setMode("select");
		this.noteInput.onSubmit = () => this.setMode("select");
		this.noteInput.onEscape = () => this.setMode("select");
	}

	private note(): string | undefined {
		return this.noteInput.getValue().trim() || undefined;
	}

	private setMode(mode: typeof this.mode): void {
		this.mode = mode;
		this.otherInput.focused = mode === "other";
		this.noteInput.focused = mode === "note";
		this.tui.requestRender();
	}

	private finish(answer: ChoiceAnswer): void {
		if (this.req.feedback) {
			this.answer = answer;
			this.feedback = this.req.feedback(answer);
			this.setMode("feedback");
			return;
		}
		this.done(answer);
	}

	handleInput(data: string): void {
		if (this.mode === "feedback") {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || data === " ") this.done(this.answer);
			return;
		}
		if (this.mode === "other") return this.otherInput.handleInput(data);
		if (this.mode === "note") return this.noteInput.handleInput(data);

		if (matchesKey(data, Key.escape)) return this.done(undefined);
		if (matchesKey(data, Key.tab) && this.req.allowNote) return this.setMode("note");
		if (matchesKey(data, Key.up)) {
			this.cursor = (this.cursor - 1 + this.rows.length) % this.rows.length;
		} else if (matchesKey(data, Key.down)) {
			this.cursor = (this.cursor + 1) % this.rows.length;
		} else if (/^[1-9]$/.test(data) && Number(data) <= this.req.options.length) {
			this.cursor = Number(data) - 1;
			if (!this.req.multi) return this.activate();
			this.toggle(this.cursor);
		} else if (matchesKey(data, Key.space) && this.req.multi && this.rows[this.cursor]?.kind === "option") {
			this.toggle((this.rows[this.cursor] as { index: number }).index);
		} else if (matchesKey(data, Key.enter)) {
			return this.activate();
		}
		this.tui.requestRender();
	}

	private toggle(index: number): void {
		if (this.checked.has(index)) this.checked.delete(index);
		else this.checked.add(index);
	}

	private activate(): void {
		const row = this.rows[this.cursor]!;
		switch (row.kind) {
			case "option":
				if (this.req.multi) {
					this.toggle(row.index);
					this.tui.requestRender();
				} else {
					this.finish({ kind: "options", selected: [row.index], note: this.note() });
				}
				return;
			case "submit":
				if (this.checked.size > 0) this.finish({ kind: "options", selected: [...this.checked].sort((a, b) => a - b), note: this.note() });
				return;
			case "other":
				return this.setMode("other");
			case "dont_know":
				return this.finish({ kind: "dont_know", note: this.note() });
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		lines.push(truncateToWidth(t.fg("accent", `── ${this.req.title} ${"─".repeat(Math.max(0, width - this.req.title.length - 4))}`), width));
		lines.push(...wrapLines(t.fg("text", t.bold(mathText(this.req.question))), width, " "));
		if (this.req.details) {
			lines.push("");
			lines.push(...wrapLines(t.fg("muted", mathText(this.req.details)), width, " "));
		}
		lines.push("");

		const selectedSet = new Set(this.answer?.kind === "options" ? this.answer.selected : []);
		const correctSet = new Set(this.feedback?.correct ?? []);
		this.rows.forEach((row, i) => {
			const focused = this.mode === "select" && i === this.cursor;
			const pointer = focused ? t.fg("accent", "› ") : "  ";
			if (row.kind === "option") {
				const opt = this.req.options[row.index]!;
				const label = `${row.index + 1}. ${mathText(opt.label)}`;
				let mark = "";
				let styled = focused ? t.fg("accent", label) : t.fg("text", label);
				if (this.mode === "feedback") {
					const sel = selectedSet.has(row.index);
					const key = correctSet.has(row.index);
					const dk = this.feedback?.verdict === "dont_know";
					mark = key ? t.fg("success", "✓ ") : sel && !dk ? t.fg("error", "✗ ") : "  ";
					styled = key ? t.fg("success", label) : sel && !dk ? t.fg("error", label) : t.fg("dim", label);
				} else if (this.req.multi) {
					mark = this.checked.has(row.index) ? t.fg("accent", "[x] ") : t.fg("dim", "[ ] ");
				}
				lines.push(...wrapLines(`${pointer}${mark}${styled}`, width));
				if (opt.description && this.mode !== "feedback") lines.push(...wrapLines(t.fg("muted", mathText(opt.description)), width, "      "));
			} else if (this.mode !== "feedback") {
				const label = row.kind === "submit" ? "Submit" : row.kind === "other" ? "Other… (type your own)" : "I don't know";
				if (row.kind !== "submit") lines.push("");
				lines.push(truncateToWidth(`${pointer}${focused ? t.fg("accent", label) : t.fg("dim", label)}`, width));
			}
		});

		if (this.mode === "other") {
			lines.push("");
			lines.push(...this.otherInput.render(width - 2).map((l) => ` ${l}`));
		}
		if (this.req.allowNote && this.mode !== "feedback") {
			lines.push("");
			if (this.mode === "note") lines.push(...this.noteInput.render(width - 2).map((l) => ` ${l}`));
			else {
				const note = this.note();
				lines.push(truncateToWidth(t.fg("dim", note ? ` Note: ${note}  (Tab to edit)` : " Tab: add a note"), width));
			}
		}

		if (this.mode === "feedback" && this.feedback) {
			lines.push("");
			const v = this.feedback.verdict;
			const head =
				v === "correct"
					? t.fg("success", " ✓ Correct")
					: v === "incorrect"
						? t.fg("error", " ✗ Not quite")
						: v === "dont_know"
							? t.fg("warning", " · You said: I don't know")
							: "";
			if (head) lines.push(head);
			for (const l of this.feedback.lines) lines.push(...wrapLines(t.fg("muted", mathText(l)), width, " "));
			lines.push("");
			lines.push(t.fg("dim", " Enter to continue"));
		} else {
			lines.push("");
			const hints = this.req.multi ? "↑↓ move · Space toggle · Enter select · Esc cancel" : "↑↓ move · Enter select · 1-9 pick · Esc cancel";
			lines.push(truncateToWidth(t.fg("dim", ` ${hints}`), width));
		}
		return lines;
	}

	invalidate(): void {}
}

const LOCK_KEY = Symbol.for("pi-learn.ui-lock");
const g = globalThis as Record<symbol, unknown>;

/**
 * Serialize dialogs: tool calls can run in parallel, and two dialogs fighting for the same
 * keyboard would be unusable. Shared through globalThis so every extension in this package
 * uses one lock.
 */
export function withUiLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = (g[LOCK_KEY] as Promise<unknown> | undefined) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(fn);
	g[LOCK_KEY] = next.catch(() => {});
	return next;
}

/** Show a choice dialog. Returns undefined when cancelled or when there is no interactive UI. */
export function showChoice(ctx: ExtensionContext, req: ChoiceRequest): Promise<ChoiceAnswer | undefined> {
	return withUiLock(() => showChoiceUnlocked(ctx, req));
}

async function showChoiceUnlocked(ctx: ExtensionContext, req: ChoiceRequest): Promise<ChoiceAnswer | undefined> {
	if (ctx.mode !== "tui") {
		if (!ctx.hasUI) return undefined;
		// RPC clients only get the standard dialogs.
		const labels = req.options.map((o, i) => `${i + 1}. ${o.label}`);
		if (req.allowDontKnow) labels.push("I don't know");
		const pick = await ctx.ui.select(`${req.title}: ${req.question}`, labels);
		if (pick === undefined) return undefined;
		const idx = labels.indexOf(pick);
		return idx < req.options.length ? { kind: "options", selected: [idx] } : { kind: "dont_know" };
	}
	return ctx.ui.custom<ChoiceAnswer | undefined>((tui, theme, _kb, done) => {
		const c = new ChoiceComponent(req, theme as unknown as ThemeLike, tui, done);
		return c;
	});
}
