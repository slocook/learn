import { renderLatex, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { terminalLatex } from "./latex.ts";

/** Replace $…$ and $$…$$ with terminal Unicode where pi-tui can render it; leave the rest as written. */
export function mathText(text: string): string {
	return text
		.replace(/\$\$([\s\S]+?)\$\$/g, (m, src: string) => renderLatex(terminalLatex(src.trim()), { display: true }) ?? m)
		.replace(/\$([^$\n]+?)\$/g, (m, src: string) => renderLatex(terminalLatex(src.trim())) ?? m);
}

export function wrapLines(text: string, width: number, indent = ""): string[] {
	const out: string[] = [];
	const contentWidth = Math.max(1, width - indent.length);
	for (const para of text.split("\n")) {
		if (para.length === 0) {
			out.push("");
			continue;
		}
		for (const line of wrapTextWithAnsi(para, contentWidth)) out.push(truncateToWidth(`${indent}${line}`, width));
	}
	return out;
}

/** Minimal theme surface used by our components (a subset of pi's Theme). */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}
