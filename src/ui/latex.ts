// pi's terminal LaTeX renderer handles single-letter accents (\vec{v} → v⃗) but prints
// multi-letter ones as text ("overrightarrow(OP)"). Spread them over each letter instead.
// Display-only: the model's text and markdown logs keep the original LaTeX.

const ARROW = /\\(?:overrightarrow|vec)\s*\{\s*([A-Za-z0-9]{2,})\s*\}/g;
const BAR = /\\(?:overline|bar)\s*\{\s*([A-Za-z0-9]{2,})\s*\}/g;

/** Replace \boxed{…} with its contents (balanced braces). The terminal draws the box as [ … ], which reads like a matrix. */
function unbox(src: string): string {
	let out = "";
	let i = 0;
	for (;;) {
		const at = src.indexOf("\\boxed", i);
		if (at === -1) return out + src.slice(i);
		const open = src.indexOf("{", at);
		if (open === -1 || src.slice(at + 6, open).trim() !== "") return out + src.slice(i);
		let depth = 0;
		let close = -1;
		for (let j = open; j < src.length; j++) {
			if (src[j] === "{" && src[j - 1] !== "\\") depth++;
			else if (src[j] === "}" && src[j - 1] !== "\\" && --depth === 0) {
				close = j;
				break;
			}
		}
		if (close === -1) return out + src.slice(i);
		out += src.slice(i, at) + src.slice(open + 1, close);
		i = close + 1;
	}
}

export function terminalLatex(src: string): string {
	return unbox(src)
		.replace(ARROW, (_m, letters: string) => [...letters].map((c) => `\\vec{${c}}`).join(""))
		.replace(BAR, (_m, letters: string) => [...letters].map((c) => `\\bar{${c}}`).join(""));
}

/**
 * Join a display-math block onto one line. In LaTeX a newline is only whitespace, but pi's markdown
 * parser runs first: a line holding just "=" or "-" inside $$…$$ becomes a heading underline or list
 * item and the block falls apart (\\ collapses to \ and the raw source shows).
 */
function joinDisplayMath(block: string, open: string, close: string): string {
	const inner = block.slice(open.length, block.length - close.length);
	return `${open} ${inner.replace(/\s*\n\s*/g, " ").trim()} ${close}`;
}

/**
 * Make math spans ($…$, $$…$$, \(…\), \[…\]) safe and drawable for the terminal; leave everything else
 * alone. With `rewrite` off, only join display blocks (for a renderer that draws full LaTeX).
 */
export function terminalLatexInMarkdown(markdown: string, rewrite = true): string {
	return markdown.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g, (m) => {
		const fixed = rewrite ? terminalLatex(m) : m;
		if (fixed.startsWith("$$")) return joinDisplayMath(fixed, "$$", "$$");
		if (fixed.startsWith("\\[")) return joinDisplayMath(fixed, "\\[", "\\]");
		return fixed;
	});
}
