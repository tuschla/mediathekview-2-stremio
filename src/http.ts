import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { NotFoundError, type Addon } from './addon.ts';
import { OverloadedError, UpstreamError } from './upstream.ts';

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * /{resource}/{type}/{id}[/{extra}].json, extra being a query string. Matched against path and query
 * together: some clients (Remux) do not percent-encode extras, so "search=AC/DC" and
 * "search=Wer weiß denn sowas?" arrive with a literal "/" or "?".
 */
const RESOURCE_PATH = /^\/(catalog|meta|stream)\/([^/?]+)\/([^/?]+?)(?:\/(.+))?\.json(?:\?.*)?$/;
/** An "&" that does not start another extra is part of the search term ("Tom & Jerry"). */
const LITERAL_AMPERSAND = /&(?!(?:search|skip)=)/g;
const IMAGE_PATH = /^\/img\/([^/]+)\.jpg$/;
/** Stremio clients call add-ons cross-origin. */
const CORS_HEADERS = { 'access-control-allow-origin': '*' };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, 'cache-control': 'no-cache', ...headers });
  res.end(JSON.stringify(body));
}

function decode(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    throw new HttpError(400, 'malformed percent-encoding');
  }
}

/** Unencoded extras: a literal "+" or "&" belongs to the term. */
function parseExtra(extra: string | undefined): URLSearchParams {
  return new URLSearchParams(extra?.replaceAll('+', '%2B').replace(LITERAL_AMPERSAND, '%26'));
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof OverloadedError) return 503;
  if (err instanceof UpstreamError) return 502;
  return 500;
}

/** Image links point at `publicUrl`, else at the request's Host; forwarded headers are not trusted. */
export function createHandler(addon: Addon, publicUrl: string | undefined): RequestListener {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = URL.parse(req.url ?? '', 'http://localhost');
    if (!url) throw new HttpError(400, 'malformed request target');
    const path = url.pathname;

    if (path === '/manifest.json') return sendJson(res, 200, addon.manifest());
    if (path === '/health') return sendJson(res, 200, { ok: true });

    const image = IMAGE_PATH.exec(path);
    if (image) {
      const location = await addon.image(decode(image[1]!));
      if (!location) throw new HttpError(404, 'no image');
      res.writeHead(302, { location, ...CORS_HEADERS, 'cache-control': 'public, max-age=86400' });
      res.end();
      return;
    }

    const route = RESOURCE_PATH.exec(path + url.search);
    if (!route) throw new HttpError(404, 'not found');
    const [, resource, type = '', rawId = '', extra] = route;
    const id = decode(rawId);

    const baseUrl = () => {
      if (publicUrl) return publicUrl;
      if (!req.headers.host) throw new HttpError(400, 'missing Host header');
      return `http://${req.headers.host}`;
    };
    const body =
      resource === 'catalog'
        ? await addon.catalog(type, id, parseExtra(extra), baseUrl())
        : resource === 'meta'
          ? await addon.meta(type, id, baseUrl())
          : await addon.stream(id);
    sendJson(res, 200, body, {
      'cache-control': body.cacheMaxAge ? `public, max-age=${body.cacheMaxAge}` : 'no-cache',
      ...(publicUrl ? {} : { vary: 'Host' }),
    });
  }

  return (req, res) => {
    const started = performance.now();
    res.on('finish', () => console.log(`${req.method} ${req.url} ${res.statusCode} ${Math.round(performance.now() - started)}ms`));
    handle(req, res).catch((err: unknown) => {
      const status = statusOf(err);
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) console.error(`${req.method} ${req.url}:`, err);
      else if (status >= 502) console.warn(`${req.method} ${req.url}: ${message}`);
      if (res.headersSent) return;
      // Internal errors may carry details that clients should not see.
      sendJson(res, status, { err: status === 500 ? 'internal error' : message }, status === 503 ? { 'retry-after': '10' } : {});
    });
  };
}
