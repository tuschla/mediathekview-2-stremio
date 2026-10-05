import { Upstream } from './upstream.ts';

const OG_IMAGE_PATTERNS = [
  /<meta\s[^>]{0,500}property=["']og:image["'][^>]{0,500}content=["']([^"'<>\s]{1,2048})["']/i,
  /<meta\s[^>]{0,500}content=["']([^"'<>\s]{1,2048})["'][^>]{0,500}property=["']og:image["']/i,
];
/** Longer than any match, so a tag split across chunks still matches. */
const OVERLAP = 4096;
/** og:image usually sits in the first few KB of a page. */
const MAX_READ_CHARS = 256 * 1024;
/** ARTE pages sometimes stream their metadata after ~1 MB of body, so ARTE images come from its player API. */
const ARTE_PAGE = /^https:\/\/www\.arte\.tv\/(\w+)\/videos\/([\w-]+)\//;

interface ArtePlayerConfig {
  data?: { attributes?: { metadata?: { images?: Array<{ url?: string }> } } };
}

const pages = new Upstream({ concurrency: 4, queueTimeoutMs: 30_000, requestTimeoutMs: 10_000 });

function httpUrl(raw: string, base?: string): URL | undefined {
  const url = URL.parse(raw, base);
  return url?.protocol === 'https:' || url?.protocol === 'http:' ? url : undefined;
}

/** The first og:image URL in the page's <head>, reading no further than necessary. */
async function readOgImage(body: ReadableStream<Uint8Array>, pageUrl: string): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let html = '';
  // Leaving the loop cancels the rest of the body.
  for await (const chunk of body) {
    const scanFrom = Math.max(0, html.length - OVERLAP);
    html += decoder.decode(chunk, { stream: true });
    const recent = html.slice(scanFrom);
    for (const pattern of OG_IMAGE_PATTERNS) {
      const m = pattern.exec(recent);
      if (m) return httpUrl(m[1]!.replaceAll('&amp;', '&'), pageUrl)?.href;
    }
    if (html.length > MAX_READ_CHARS || recent.includes('</head>')) break;
  }
  return undefined;
}

/** Artwork of a broadcaster page, or undefined if it has none or is gone. */
export async function findImage(pageUrl: string): Promise<string | undefined> {
  const page = httpUrl(pageUrl);
  if (!page) return undefined;
  const arte = ARTE_PAGE.exec(page.href);
  if (arte) {
    return pages.fetch(`https://api.arte.tv/api/player/v2/config/${arte[1]}/${arte[2]}`, {}, async (res) => {
      if (!res.ok) return undefined;
      const url = ((await res.json()) as ArtePlayerConfig).data?.attributes?.metadata?.images?.[0]?.url;
      return url && httpUrl(url)?.href;
    });
  }
  return pages.fetch(page, { headers: { accept: 'text/html' } }, async (res) =>
    res.ok && res.body && res.headers.get('content-type')?.includes('text/html') ? readOgImage(res.body, res.url) : undefined,
  );
}
