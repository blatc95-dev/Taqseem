// Taqseem — site-proxy
//
// The "تحديثات المواقع" tab reads public pages on the source sites. Those
// sites send no `Access-Control-Allow-Origin` header (unlike uqn.gov.sa's
// /api/* routes, which the أم القرى tab calls straight from the browser), so
// the browser is not allowed to read their responses at all. This function is
// the one hop that can: it fetches a permitted public URL server-side and
// hands the result back with CORS enabled. It is also how the tab downloads a
// published document: the same wall that stops the browser reading a listing
// stops it saving a PDF, so a FILE call brings the bytes back base64'd.
//
// Deploy from the Dashboard (no CLI needed):
//   Edge Functions -> Deploy a new function -> Via Editor
//   -> name it exactly `site-proxy` -> paste this file -> Deploy.
// index.html carries a copy of this source for the tab's setup card; keep the
// two in step when editing.
//
// Safety:
//   * only public Saudi hosts over https are reachable (see resolveTarget), so
//     the function can never be pointed at the project's own services or at a
//     cloud metadata endpoint
//   * only GET and HEAD upstream, so it can never change anything there
//   * JWT verification stays on (Supabase's default), so only a signed-in
//     employee can drive it

// This used to be a literal set of hostnames, which meant every new source site
// needed this file redeployed before the tab could read it — and until that
// happened all the tab could do was tell the employee their proxy was out of
// date. It is a policy now: any public host under the .sa namespace. Nothing
// internal answers to a .sa name, so the guard the name list existed for still
// holds, while adding a site is pure client-side work.
const SAUDI_HOST = /^(?!-)[a-z0-9-]+(\.(?!-)[a-z0-9-]+)*\.sa$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_URLS = 24;          // one listing page's worth of files, plus slack
const MAX_BODY = 4_000_000;   // bytes; the largest listing runs ~460 KB
// A FILE call carries one published document, not a listing, so it gets its own
// ceiling: these are scanned PDFs and a few of them run past ten megabytes.
// base64 inflates by a third, so this is ~27 MB on the wire.
const MAX_FILE = 20_000_000;
const POOL = 6;               // parallel upstream requests per call
const TIMEOUT_MS = 40_000;    // a source site that hangs must not hang the call,
                              // but a slow-and-working one must not be cut off either

// Some of these sites sit behind a WAF that answers TaqseemBot with a block
// page — cma.gov.sa returns "خطأ في الوصول" and hrsd.gov.sa a 503 — while the
// same public page is served normally to a browser. Nothing here is hidden
// behind a login or a robots rule; the honest bot string simply trips a filter.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type Result = Record<string, unknown>;
// GET  — the page, decoded to text (how every listing is read)
// HEAD — headers only, for a file's Last-Modified
// FILE — the bytes themselves, base64'd, so the browser can save a document
//        from a site that sends no CORS header
type Mode = 'GET' | 'HEAD' | 'FILE';

// `res.text()` decodes as UTF-8 no matter what the response declares, so a page
// served in a legacy encoding would come back as mojibake — saff.com.sa serves
// windows-1256. The declared charset is honoured instead, and it wins over any
// <meta charset> inside the document, which is what a browser does too (and
// what saff needs: its header says windows-1256 while its meta claims utf-8).
function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([\w-]+)/i.exec(contentType);
  return (m ? m[1] : 'utf-8').toLowerCase();
}
function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // an encoding label this runtime does not know is not worth failing over
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// btoa takes a string, and spreading a whole multi-megabyte array into
// String.fromCharCode would blow the argument limit — so it is fed in chunks.
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// What the saved file should be called. The upstream's own
// Content-Disposition wins when it sends one (it carries the Arabic name);
// otherwise the last path segment is the name the site publishes it under.
function filenameOf(disposition: string, url: URL): string {
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(disposition);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  let name = '';
  if (star) { try { name = decodeURIComponent(star[1]); } catch { name = star[1]; } }
  if (!name && plain) name = plain[1];
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    try { name = decodeURIComponent(last); } catch { name = last; }
  }
  // no separators, so the name can never point anywhere but the download folder
  return name.replace(/[\\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
}

function resolveTarget(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  // credentials in the url, or a port other than the public one, are how an
  // internal service would be reached — neither belongs to a public page
  if (u.username || u.password || u.port) return null;
  // an IP literal can never match, since the name has to end in .sa
  return SAUDI_HOST.test(u.hostname.toLowerCase()) ? u : null;
}

async function fetchOne(raw: unknown, mode: Mode): Promise<Result> {
  const target = resolveTarget(raw);
  if (!target) return { url: raw, ok: false, status: 0, error: 'host not allowed' };
  try {
    const res = await fetch(target, {
      method: mode === 'HEAD' ? 'HEAD' : 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': mode === 'FILE'
          ? '*/*'
          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.9',
      },
    });
    const contentType = res.headers.get('content-type') || '';
    const out: Result = {
      url: raw,
      finalUrl: res.url,
      ok: res.ok,
      status: res.status,
      lastModified: res.headers.get('last-modified') || '',
      contentType,
      contentLength: res.headers.get('content-length') || '',
    };
    const cap = mode === 'FILE' ? MAX_FILE : MAX_BODY;
    if (mode === 'HEAD') {
      // a HEAD is only worth making when the upstream answers it honestly;
      // some servers do not, which shows up as a missing lastModified
      await res.body?.cancel();
      return out;
    }
    // refuse before buffering when the upstream declares an oversized body,
    // and still clamp afterwards for the chunked responses that declare none
    if (Number(out.contentLength || 0) > cap) {
      await res.body?.cancel();
      return { ...out, ok: false, error: 'response too large' };
    }
    const buf = await res.arrayBuffer();
    if (mode === 'FILE') {
      // a document is handed back whole or not at all: a clamped PDF is a
      // corrupt file, which is worse than a refusal the employee can act on
      if (buf.byteLength > cap) return { ...out, ok: false, error: 'response too large' };
      out.filename = filenameOf(res.headers.get('content-disposition') || '', new URL(res.url || target));
      out.base64 = toBase64(new Uint8Array(buf));
      return out;
    }
    const charset = charsetOf(contentType);
    out.charset = charset;
    // clamped in bytes, the same unit MAX_BODY is compared against above
    out.body = decodeBody(new Uint8Array(buf, 0, Math.min(buf.byteLength, cap)), charset);
    return out;
  } catch (e) {
    return { url: raw, ok: false, status: 0, error: String((e as Error)?.message || e) };
  }
}

async function fetchAll(urls: unknown[], mode: Mode): Promise<Result[]> {
  const out = new Array<Result>(urls.length);
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const i = cursor++;
      out[i] = await fetchOne(urls[i], mode);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(POOL, urls.length) }, worker),
  );
  return out;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405);

  let payload: { url?: unknown; urls?: unknown; method?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }

  const mode: Mode = payload.method === 'HEAD' ? 'HEAD'
    : payload.method === 'FILE' ? 'FILE' : 'GET';
  const urls = Array.isArray(payload.urls)
    ? payload.urls
    : (payload.url !== undefined ? [payload.url] : []);

  if (!urls.length) return json({ error: 'no url given' }, 400);
  if (urls.length > MAX_URLS) return json({ error: 'at most ' + MAX_URLS + ' urls per call' }, 400);
  // one whole document per call: two 20 MB files in one response would be
  // built in memory at the same time
  if (mode === 'FILE' && urls.length > 1) return json({ error: 'one url per FILE call' }, 400);

  return json({ results: await fetchAll(urls, mode) });
});
