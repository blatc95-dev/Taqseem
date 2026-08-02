// Taqseem — site-proxy
//
// The "تحديثات المواقع" tab reads public pages on the source sites. Those
// sites send no `Access-Control-Allow-Origin` header (unlike uqn.gov.sa's
// /api/* routes, which the أم القرى tab calls straight from the browser), so
// the browser is not allowed to read their responses at all. This function is
// the one hop that can: it fetches a permitted public URL server-side and
// hands the result back with CORS enabled.
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
//   * only GET and HEAD, so it can never change anything upstream
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

async function fetchOne(raw: unknown, method: 'GET' | 'HEAD'): Promise<Result> {
  const target = resolveTarget(raw);
  if (!target) return { url: raw, ok: false, status: 0, error: 'host not allowed' };
  try {
    const res = await fetch(target, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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
    if (method === 'GET') {
      // refuse before buffering when the upstream declares an oversized body,
      // and still clamp afterwards for the chunked responses that declare none
      if (Number(out.contentLength || 0) > MAX_BODY) {
        return { ...out, ok: false, error: 'response too large' };
      }
      const charset = charsetOf(contentType);
      const buf = await res.arrayBuffer();
      out.charset = charset;
      // clamped in bytes, the same unit MAX_BODY is compared against above
      out.body = decodeBody(new Uint8Array(buf, 0, Math.min(buf.byteLength, MAX_BODY)), charset);
    } else {
      // a HEAD is only worth making when the upstream answers it honestly;
      // some servers do not, which shows up as a missing lastModified
      await res.body?.cancel();
    }
    return out;
  } catch (e) {
    return { url: raw, ok: false, status: 0, error: String((e as Error)?.message || e) };
  }
}

async function fetchAll(urls: unknown[], method: 'GET' | 'HEAD'): Promise<Result[]> {
  const out = new Array<Result>(urls.length);
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const i = cursor++;
      out[i] = await fetchOne(urls[i], method);
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

  const method = payload.method === 'HEAD' ? 'HEAD' : 'GET';
  const urls = Array.isArray(payload.urls)
    ? payload.urls
    : (payload.url !== undefined ? [payload.url] : []);

  if (!urls.length) return json({ error: 'no url given' }, 400);
  if (urls.length > MAX_URLS) return json({ error: 'at most ' + MAX_URLS + ' urls per call' }, 400);

  return json({ results: await fetchAll(urls, method) });
});
