import type { Model } from "@earendil-works/pi-ai";
import { defineTool, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Type } from "typebox";
import type { LearnConfig } from "../../config.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 30_000;

type SearchProvider = "native" | "brave" | "tavily" | "duckduckgo";

/** Provider-side search tool for a model's API, injected into the request payload. */
function nativeSearchTool(model: Model<any>): Record<string, unknown> | undefined {
	const api = String(model.api);
	if (api.includes("openai") && api.includes("responses")) return { type: "web_search" };
	if (api === "anthropic-messages") return { type: "web_search_20250305", name: "web_search", max_uses: 5 };
	return undefined;
}

export function supportsNativeSearch(model: Model<any> | undefined): boolean {
	return model !== undefined && nativeSearchTool(model) !== undefined;
}

async function searchNative(registry: ModelRegistry, model: Model<any>, query: string, signal?: AbortSignal): Promise<string> {
	const tool = nativeSearchTool(model);
	if (!tool) throw new Error(`${model.provider}/${model.id} has no native web search`);
	const prompt =
		`Search the web for: ${query}\n\n` +
		"Reply with a digest of the 5–8 most relevant sources. For each: title, URL, and the key facts it states, " +
		"quoted or closely paraphrased. Prefer primary and authoritative sources (papers, textbooks, official docs). " +
		"Do not add facts that are not in the sources.";
	const stream = registry.streamSimple(
		model,
		{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
		{
			signal,
			onPayload: (payload: unknown) => {
				const p = payload as { tools?: unknown[] };
				return { ...p, tools: [...(p.tools ?? []), tool] };
			},
		},
	);
	let text = "";
	let error: string | undefined;
	for await (const event of stream) {
		if (event.type === "text_delta") text += event.delta;
		else if (event.type === "error") error = event.error?.errorMessage ?? "search failed";
	}
	if (error) throw new Error(error);
	if (!text.trim()) throw new Error("native search returned nothing");
	return text.trim();
}

async function getJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
	const res = await fetch(url, { ...init, signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json();
}

function formatResults(results: { title: string; url: string; snippet: string }[]): string {
	if (results.length === 0) throw new Error("no results");
	return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").trim()}`).join("\n");
}

async function searchBrave(query: string, signal?: AbortSignal): Promise<string> {
	const key = process.env.BRAVE_API_KEY;
	if (!key) throw new Error("BRAVE_API_KEY is not set");
	const body = await getJson(
		`https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(query)}`,
		{ headers: { Accept: "application/json", "X-Subscription-Token": key } },
		signal,
	);
	return formatResults(
		(body?.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description ?? "" })),
	);
}

async function searchTavily(query: string, signal?: AbortSignal): Promise<string> {
	const key = process.env.TAVILY_API_KEY;
	if (!key) throw new Error("TAVILY_API_KEY is not set");
	const body = await getJson(
		"https://api.tavily.com/search",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: key, query, max_results: 8 }),
		},
		signal,
	);
	return formatResults((body?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? "" })));
}

async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<string> {
	const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
		headers: { "User-Agent": UA },
		signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const html = await res.text();
	if (/anomaly|bots use DuckDuckGo/i.test(html)) throw new Error("DuckDuckGo is rate-limiting automated searches");
	const { document } = parseHTML(html);
	const results = [...document.querySelectorAll(".result")].slice(0, 8).map((el: any) => {
		const a = el.querySelector(".result__a");
		let url = a?.getAttribute("href") ?? "";
		const uddg = /[?&]uddg=([^&]+)/.exec(url);
		if (uddg) url = decodeURIComponent(uddg[1]!);
		return { title: a?.textContent?.trim() ?? "", url, snippet: el.querySelector(".result__snippet")?.textContent ?? "" };
	});
	return formatResults(results.filter((r) => r.url));
}

export interface SearchEnv {
	config: LearnConfig;
	registry: ModelRegistry;
	/** The model the researcher runs on; native search uses it. */
	model?: Model<any>;
}

function providerOrder(env: SearchEnv): SearchProvider[] {
	const configured = env.config.search.provider;
	if (configured !== "auto") return [configured];
	const order: SearchProvider[] = [];
	if (supportsNativeSearch(env.model)) order.push("native");
	if (process.env.BRAVE_API_KEY) order.push("brave");
	if (process.env.TAVILY_API_KEY) order.push("tavily");
	order.push("duckduckgo");
	return order;
}

export async function webSearch(env: SearchEnv, query: string, signal?: AbortSignal): Promise<{ provider: SearchProvider; text: string }> {
	const failures: string[] = [];
	for (const provider of providerOrder(env)) {
		try {
			const text =
				provider === "native"
					? await searchNative(env.registry, env.model!, query, signal)
					: provider === "brave"
						? await searchBrave(query, signal)
						: provider === "tavily"
							? await searchTavily(query, signal)
							: await searchDuckDuckGo(query, signal);
			return { provider, text };
		} catch (e) {
			failures.push(`${provider}: ${(e as Error).message}`);
		}
	}
	throw new Error(`web search failed (${failures.join("; ")}). Set BRAVE_API_KEY or TAVILY_API_KEY, or use a model with native search.`);
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export async function webFetch(url: string, signal?: AbortSignal): Promise<{ title: string; markdown: string }> {
	const res = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
		redirect: "follow",
		signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	const type = res.headers.get("content-type") ?? "";
	if (type.includes("pdf")) throw new Error("PDFs are not supported; look for an HTML version of the source");
	const body = await res.text();
	if (!type.includes("html")) return { title: url, markdown: body };
	const { document } = parseHTML(body);
	const article = new Readability(document as unknown as Document).parse();
	const html = article?.content ?? document.body?.innerHTML ?? body;
	return { title: article?.title ?? document.title ?? url, markdown: turndown.turndown(html).replace(/\n{3,}/g, "\n\n") };
}

export function webTools(env: SearchEnv): ToolDefinition<any, any>[] {
	return [
		defineTool({
			name: "web_search",
			label: "Web search",
			description: "Search the web. Returns sources with URLs and key facts. Use varied queries to cover different angles.",
			parameters: Type.Object({ query: Type.String({ description: "What to search for." }) }),
			async execute(_id, params, signal) {
				const { provider, text } = await webSearch(env, params.query, signal);
				return { content: [{ type: "text", text: `[${provider}]\n${text}` }], details: undefined };
			},
		}),
		defineTool({
			name: "web_fetch",
			label: "Web fetch",
			description: "Fetch a web page and return its main content as markdown. Long pages are paginated with `offset`.",
			parameters: Type.Object({
				url: Type.String(),
				offset: Type.Optional(Type.Number({ description: "Character offset to continue from." })),
			}),
			async execute(_id, params, signal) {
				const { title, markdown } = await webFetch(params.url, signal);
				const offset = Math.max(0, Math.floor(params.offset ?? 0));
				const limit = 20_000;
				const slice = markdown.slice(offset, offset + limit);
				const more = offset + limit < markdown.length ? `\n\n[truncated: call again with offset ${offset + limit} for more]` : "";
				return { content: [{ type: "text", text: `# ${title}\n${params.url}\n\n${slice}${more}` }], details: undefined };
			},
		}),
	];
}
