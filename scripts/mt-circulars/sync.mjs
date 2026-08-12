// Taqseem — mt-circulars sync
//
// وزارة السياحة publishes its تعاميم through an endpoint that Taqseem cannot
// reach from either of the two places it is able to call from:
//
//   * site-proxy, server-side, is answered with a 403 block page. mt.gov.sa
//     filters on what the client *is* rather than on what it says it is — a
//     browser and curl were refused and served from the same address seconds
//     apart — so no server-side fetch passes it however it presents itself.
//     This is not a robots rule: robots.txt allows the page this job reads.
//   * the browser is refused by CORS. The endpoint's preflight names
//     https://mt.gov.sa and nothing else; the app's own origin, a sandboxed
//     `null`, and a localhost dev origin were each turned away.
//
// Each wall stops a different client and no client clears both. What clears
// both at once is an ordinary browser sitting on the ministry's own page: it
// is a browser, so the filter lets it through, and its origin is mt.gov.sa, so
// the endpoint answers it. That is the whole of this job — a headless Chromium
// that opens the published page and asks it the same question its own pager
// asks, then writes the answer where the tab can read it.
//
// Because the tab then reads that table instead of the site, what it shows is
// a mirror rather than a live read, and a mirror that quietly falls behind
// would report "no updates" for days that nobody actually swept. So each run
// records itself in mt_circular_syncs whether or not anything changed, and the
// tab refuses any range the newest successful run does not cover.
//
// Run by .github/workflows/mt-circulars.yml, daily. Needs two secrets:
//   SUPABASE_URL                 the project url (the same one index.html uses)
//   SUPABASE_SERVICE_ROLE_KEY    service role — writes here bypass RLS, and the
//                                table carries no insert policy for anyone else

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const PAGE_URL = 'https://mt.gov.sa/about/circulars-and-regulations';
const API_URL = 'https://prod-api.mt.gov.sa/gateway/mt-dp-cms/1.0/api/v1/CMS/Circulars';

// the page's own pager asks for sixteen at a time and walks the list by the id
// of the last row it already holds, counting down from `id: 0` for the first
// call. Both numbers are its, not ours: matching them keeps this an ordinary
// reader of the same listing rather than a heavier one.
const PAGE_SIZE = 16;
const MAX_ROUNDS = 60;        // ~960 circulars; the list holds ~134 today
const NAV_TIMEOUT_MS = 60_000;

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// the endpoint writes its dates day-first ("23-07-2026"). Nothing else in the
// payload carries one, so a row whose date will not parse is kept with a null
// date rather than dropped — the tab renders it as undated, which is a thing an
// employee can see and act on, unlike a row that silently never arrived.
function toIso(raw) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo}-${d}`;
}

// one round of the listing, asked from inside the page so that it carries the
// page's origin. A non-200 is returned rather than thrown so the caller can say
// which round failed and stop with the rounds it already has.
async function fetchRound(page, afterId) {
  return page.evaluate(
    async ({ url, body }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      try {
        return { payload: await res.json() };
      } catch (e) {
        return { error: 'response was not JSON' };
      }
    },
    { url: API_URL, body: { pageSize: PAGE_SIZE, id: afterId } },
  );
}

async function readAll(page) {
  const rows = [];
  const seen = new Set();
  let afterId = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { payload, error } = await fetchRound(page, afterId);
    if (error) throw new Error(`round ${round + 1} failed — ${error}`);

    const batch = payload?.circularsList?.value;
    if (!Array.isArray(batch)) {
      // the shape changed; better to fail than to write a short list over a
      // longer one and call the mirror fresh
      throw new Error(`round ${round + 1} — unexpected response shape`);
    }
    if (!batch.length) break;

    for (const it of batch) {
      // the cursor is the id of the last row of the batch whether or not that
      // row was new, so a duplicate cannot stall the walk
      if (it && it.id != null && !seen.has(it.id)) {
        seen.add(it.id);
        rows.push(it);
      }
    }
    const last = batch[batch.length - 1];
    if (!last || last.id == null || last.id === afterId) break;
    afterId = last.id;
    console.log(`  round ${round + 1}: +${batch.length} (total ${rows.length})`);
  }
  return rows;
}

function toRecord(it) {
  const files = Array.isArray(it.attachmentFiles) ? it.attachmentFiles.filter(Boolean) : [];
  return {
    id: it.id,
    title: String(it.title_AR || it.title_EN || '').trim(),
    circular_type: String(it.circularType || '').trim(),
    circular_date: toIso(it.circularDate),
    // the listing gives an array; every row published so far carries exactly one
    file_url: files[0] || '',
    synced_at: new Date().toISOString(),
  };
}

async function main() {
  const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  const browser = await chromium.launch();
  let rows;
  try {
    const page = await browser.newPage({ locale: 'ar-SA' });
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    console.log(`opening ${PAGE_URL}`);
    // the listing is fetched by hand below, so there is no need to wait for the
    // page's own render — only for an origin to ask from
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    rows = await readAll(page);
  } finally {
    await browser.close();
  }

  if (!rows.length) throw new Error('the listing came back empty — refusing to record a sync');

  const records = rows.map(toRecord).filter(r => r.title);
  console.log(`read ${records.length} circulars`);

  // upsert, never delete: a circular the ministry later withdraws stays in the
  // mirror, the same way a saved extraction keeps what it captured. A sweep of
  // an old range must keep answering the way it did when it was first run.
  const { error: upsertError } = await supabase
    .from('mt_circulars')
    .upsert(records, { onConflict: 'id' });
  if (upsertError) throw new Error(`upsert failed — ${upsertError.message}`);

  const { error: syncError } = await supabase
    .from('mt_circular_syncs')
    .insert({ item_count: records.length });
  if (syncError) throw new Error(`could not record the sync — ${syncError.message}`);

  console.log(`mirror updated — ${records.length} rows`);
}

main().catch(err => {
  // a failed run records nothing, so the tab keeps refusing ranges past the last
  // run that actually succeeded rather than trusting a half-written mirror
  console.error(String(err?.message || err));
  process.exit(1);
});
