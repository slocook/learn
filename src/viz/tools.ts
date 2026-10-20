import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { publishName, renderMermaid, renderSvg } from "./render.ts";

export type DiagramKind = "mermaid" | "svg";

/**
 * The diagram maker's authoring loop: write a source, edit it exactly, render it and look.
 * Rendering with `save_as` publishes the PNG into viz/ under a unique name.
 */
export function diagramTools(kind: DiagramKind, opts: { vizDir: string; browser?: string; onPreview: (file: string) => void; onPublish: (file: string) => void }) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), `pi-learn-${kind}-`));
	let source = "";
	let previews = 0;
	return [
		defineTool({
			name: "write_source",
			label: "write",
			description: `Write the full ${kind === "mermaid" ? "Mermaid" : "SVG"} source (first draft or full rewrite).`,
			parameters: Type.Object({ source: Type.String() }),
			async execute(_id, params) {
				source = params.source.trim();
				return { content: [{ type: "text", text: `Wrote ${source.split("\n").length} lines. Call render to look at it.` }], details: undefined };
			},
		}),
		defineTool({
			name: "edit_source",
			label: "edit",
			description: "Replace exactly one occurrence of old_text with new_text in the current source.",
			parameters: Type.Object({ old_text: Type.String(), new_text: Type.String() }),
			async execute(_id, params) {
				const first = source.indexOf(params.old_text);
				if (!params.old_text || first === -1) throw new Error("old_text not found; match the source exactly");
				if (source.indexOf(params.old_text, first + 1) !== -1) throw new Error("old_text appears more than once; include more context");
				source = source.slice(0, first) + params.new_text + source.slice(first + params.old_text.length);
				return { content: [{ type: "text", text: "Edited. Call render to look at it." }], details: undefined };
			},
		}),
		defineTool({
			name: "render",
			label: "render",
			description: "Render the current source to PNG and return it so you can LOOK at it. With save_as (a short topic slug), also publish it.",
			parameters: Type.Object({ save_as: Type.Optional(Type.String()) }),
			async execute(_id, params) {
				if (!source) throw new Error("no source yet; call write_source first");
				const out = path.join(work, `preview-${++previews}.png`);
				if (kind === "mermaid") await renderMermaid(source, out, opts.browser);
				else renderSvg(source, out);
				opts.onPreview(out);
				let text = "Rendered. Look at the image: is every element correct and legible?";
				if (params.save_as) {
					fs.mkdirSync(opts.vizDir, { recursive: true });
					const name = publishName(params.save_as);
					fs.copyFileSync(out, path.join(opts.vizDir, name));
					opts.onPublish(name);
					text = `Published as ${name}.`;
				}
				const data = fs.readFileSync(out).toString("base64");
				return { content: [{ type: "text", text }, { type: "image", data, mimeType: "image/png" }], details: undefined };
			},
		}),
	];
}
