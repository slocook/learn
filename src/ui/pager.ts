import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./text.ts";

/** A scrollable, read-only view of pre-rendered lines. Esc or q closes it. */
class Pager implements Component {
	private readonly title: string;
	private readonly build: (width: number) => string[];
	private readonly theme: ThemeLike;
	private readonly tui: TUI;
	private readonly done: () => void;
	private offset = 0;
	private lastHeight = 20;
	private lastTotal = 0;

	constructor(title: string, build: (width: number) => string[], theme: ThemeLike, tui: TUI, done: () => void) {
		this.title = title;
		this.build = build;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.lastHeight - 1);
		if (matchesKey(data, Key.escape) || data === "q") return this.done();
		if (matchesKey(data, Key.up) || data === "k") this.offset -= 1;
		else if (matchesKey(data, Key.down) || data === "j") this.offset += 1;
		else if (matchesKey(data, Key.pageUp)) this.offset -= page;
		else if (matchesKey(data, Key.pageDown) || data === " ") this.offset += page;
		else if (matchesKey(data, Key.home) || data === "g") this.offset = 0;
		else if (matchesKey(data, Key.end) || data === "G") this.offset = this.lastTotal;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const body = this.build(width - 2).map((l) => truncateToWidth(` ${l}`, width));
		const rows = process.stdout.rows ?? 30;
		this.lastHeight = Math.max(5, rows - 6);
		this.lastTotal = body.length;
		const maxOffset = Math.max(0, body.length - this.lastHeight);
		this.offset = Math.min(Math.max(0, this.offset), maxOffset);
		const visible = body.slice(this.offset, this.offset + this.lastHeight);
		const pos = body.length > this.lastHeight ? ` ${this.offset + 1}-${this.offset + visible.length}/${body.length}` : "";
		const header = t.fg("accent", `── ${this.title} ${"─".repeat(Math.max(0, width - this.title.length - 4))}`);
		return [
			truncateToWidth(header, width),
			...visible,
			truncateToWidth(t.fg("dim", ` ↑↓/PgUp/PgDn scroll · Esc close${pos}`), width),
		];
	}

	invalidate(): void {}
}

export async function showPager(ctx: ExtensionContext, title: string, build: (width: number) => string[]): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(build(100).join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new Pager(title, build, theme as unknown as ThemeLike, tui, () => done()));
}
