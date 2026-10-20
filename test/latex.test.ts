import assert from "node:assert/strict";
import { test } from "node:test";
import { renderLatex } from "@earendil-works/pi-tui";
import { terminalLatex, terminalLatexInMarkdown } from "../src/ui/latex.ts";

test("multi-letter accents are spread over each letter so the terminal can draw them", () => {
	assert.equal(terminalLatex("\\overrightarrow{OP} = a\\hat{x}"), "\\vec{O}\\vec{P} = a\\hat{x}");
	assert.equal(terminalLatex("\\overline{AB}"), "\\bar{A}\\bar{B}");
	assert.equal(terminalLatex("\\vec{v}"), "\\vec{v}");
	assert.doesNotMatch(renderLatex(terminalLatex("\\overrightarrow{OP}"))!, /overrightarrow/);
});

test("only math spans are rewritten", () => {
	assert.equal(terminalLatexInMarkdown("`\\vec{OP}` and $\\vec{OP}$"), "`\\vec{OP}` and $\\vec{O}\\vec{P}$");
	assert.equal(terminalLatexInMarkdown("$$\\overline{AB}$$"), "$$ \\bar{A}\\bar{B} $$");
	assert.equal(terminalLatexInMarkdown("\\(\\vec{OP}\\)"), "\\(\\vec{O}\\vec{P}\\)");
});

test("display math is joined onto one line so a lone '=' can't become a markdown heading", () => {
	const md = "coordinates are\n  $$\n  a\\\\ b\n  =\n  c\n\n  $$\n";
	assert.equal(terminalLatexInMarkdown(md), "coordinates are\n  $$ a\\\\ b = c $$\n");
	assert.equal(terminalLatexInMarkdown("\\[\nx\n=\ny\n\\]"), "\\[ x = y \\]");
	assert.equal(terminalLatexInMarkdown("inline $a$ stays"), "inline $a$ stays");
});

test("\\boxed is unwrapped for the terminal, which would draw it as brackets", () => {
	assert.equal(terminalLatex("\\boxed{p_A = R_{AB} p_B + t_{AB}}"), "p_A = R_{AB} p_B + t_{AB}");
	assert.equal(terminalLatex("x = \\boxed{\\frac{a}{b}} + 1"), "x = \\frac{a}{b} + 1");
	assert.equal(terminalLatex("\\boxed {a}"), "a");
});

test("with rewriting off, display math is still joined but LaTeX is left for a full renderer", () => {
	assert.equal(terminalLatexInMarkdown("$$\n\\boxed{\\overrightarrow{OP}}\n=\nx\n$$", false), "$$ \\boxed{\\overrightarrow{OP}} = x $$");
	assert.equal(terminalLatexInMarkdown("$\\overline{AB}$", false), "$\\overline{AB}$");
});
