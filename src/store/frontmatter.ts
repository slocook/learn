import YAML from "yaml";

const FENCE = "---";

export interface FrontmatterDoc<T> {
	data: T;
	body: string;
}

export function parseFrontmatter<T>(text: string): FrontmatterDoc<T> {
	if (!text.startsWith(`${FENCE}\n`)) return { data: {} as T, body: text };
	const end = text.indexOf(`\n${FENCE}`, FENCE.length);
	if (end === -1) return { data: {} as T, body: text };
	const yaml = text.slice(FENCE.length + 1, end);
	const rest = text.slice(end + FENCE.length + 1);
	return { data: (YAML.parse(yaml) ?? {}) as T, body: rest.replace(/^\r?\n/, "") };
}

export function formatFrontmatter(data: unknown, body: string): string {
	const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
	return `${FENCE}\n${yaml}\n${FENCE}\n${body}`;
}
