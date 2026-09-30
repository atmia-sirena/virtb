// HeyClicky's /web-search runs the paid Brave Search API. Pip needs no API key:
// a self-hosted SearXNG (open source) when PIP_SEARXNG_URL is set, DuckDuckGo's
// keyless HTML results otherwise.
import { environment } from "../config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function searxngSearch(query: string, baseUrl: string, count: number): Promise<SearchResult[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`SearXNG returned ${response.status}`);
  const body = (await response.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (body.results ?? []).slice(0, count).map((result) => ({ title: stripHtml(result.title), url: result.url, snippet: stripHtml(result.content ?? "") }));
}

async function duckDuckGoSearch(query: string, count: number): Promise<SearchResult[]> {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Pip/0.1" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);
  const html = await response.text();
  const results: SearchResult[] = [];
  const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html)) && results.length < count) {
    let url = decodeEntities(match[1]);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith("//")) url = `https:${url}`;
    results.push({ title: stripHtml(match[2]), url, snippet: stripHtml(match[3]) });
  }
  return results;
}

export async function webSearch(query: string, count = 6): Promise<SearchResult[]> {
  const searxngUrl = environment.searxngUrl;
  if (searxngUrl) {
    try {
      return await searxngSearch(query, searxngUrl, count);
    } catch (error) {
      console.warn("[search] SearXNG failed, using DuckDuckGo:", (error as Error).message);
    }
  }
  return duckDuckGoSearch(query, count);
}

export async function fetchReadableText(url: string, maxCharacters = 12000): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Pip/0.1" }, signal: AbortSignal.timeout(12000) });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!contentType.includes("html")) return body.slice(0, maxCharacters);
  const withoutNoise = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header|svg|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n");
  return stripHtml(withoutNoise.replace(/\n/g, " \n ")).slice(0, maxCharacters);
}
