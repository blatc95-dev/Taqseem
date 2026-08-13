// Taqseem — daily sweep
//
// Runs every جهة before noon so that an employee arriving at twelve reads a
// result instead of starting one.
//
// The nineteen adapters are browser code — they parse with DOMParser, they call
// site-proxy through the app's own supabase client, and one of them (وزارة
// السياحة's الأنظمة) can only be read from a browser at all. Rewriting them for
// a server would mean two copies of nineteen parsers drifting apart, and the
// copy nobody watches would be the one deciding whether a تحديث was missed.
//
// So this does not reimplement anything. It opens the deployed app in the same
// real Chrome the تعاميم mirror uses, signs in as the بحث تلقائي account, and
// calls `site.scan(range)` — the very function the employee's own press of بحث
// calls. What comes back is written here rather than through the app's save
// path, which is wired to the on-screen draft; the shape it writes is the shape
// that path writes.
//
// A جهة that threw is not written as coverage. A row in site_updates says a
// range was read, and a sweep that failed read nothing — so the failures go to
// auto_sweeps instead, where the tab shows them. Silence must never be the way
// a اجهة failure is reported.
//
// Secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   to write the results
//   AUTO_SWEEP_EMAIL, AUTO_SWEEP_PASSWORD     the بحث تلقائي account, so the
//                                             page can drive site-proxy

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const APP_URL = process.env.APP_URL || 'https://blatc95-dev.github.io/Taqseem/';

// the sites publish on Riyadh time and the tab folds every date into that day,
// so "today" has to mean the same thing here
const TZ_OFFSET_MS = 3 * 3600 * 1000;
// how far back a single run is allowed to reach when earlier ones did not run.
// Without a cap, a job stopped for a month comes back and asks nineteen sites
// for a month at once; with it, the gap is closed in bites and said out loud.
const MAX_CATCHUP_DAYS = 14;
const NAV_TIMEOUT_MS = 90_000;
const SITE_TIMEOUT_MS = 300_000;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36';

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const todayIso = () => new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// "كل يوم بيومه" on an ordinary day, and self-healing on the day after a run
// that never happened: the range starts where the last successful run stopped,
// so a missed day is picked up rather than left as a hole nobody can see.
async function decideRange(supabase) {
  const to = todayIso();
  const { data, error } = await supabase
    .from('auto_sweeps')
    .select('range_to')
    .order('ran_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`could not read the last sweep — ${error.message}`);

  const lastTo = data && data[0] && data[0].range_to;
  let from = lastTo ? shiftIso(lastTo, 1) : to;
  if (from > to) from = to;                       // already swept today
  const floor = shiftIso(to, -MAX_CATCHUP_DAYS);
  if (from < floor) {
    console.log(`capping catch-up: ${from} is further back than ${MAX_CATCHUP_DAYS} days`);
    from = floor;
  }
  return { from, to };
}

async function launchBrowser() {
  const args = ['--disable-blink-features=AutomationControlled'];
  try {
    const browser = await chromium.launch({ channel: 'chrome', args });
    console.log('launched google chrome');
    return browser;
  } catch (e) {
    console.log(`google chrome unavailable (${e.message.split('\n')[0]}) — using bundled chromium`);
    return chromium.launch({ args });
  }
}

// the app boots, reads its session and renders before any of this is callable
async function openApp(page) {
  console.log(`opening ${APP_URL}`);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  // the app is one classic <script>, so its top-level `const`s are global
  // bindings reachable by bare name but never properties of window — checking
  // window.SU_SITES would wait for something that is not coming
  await page.waitForFunction(
    () => {
      try {
        return typeof SU_SITES !== 'undefined' && typeof sb !== 'undefined';
      } catch (e) {
        return false;   // still in the temporal dead zone
      }
    },
    null,
    { timeout: NAV_TIMEOUT_MS },
  );
}

async function signIn(page, email, password) {
  const res = await page.evaluate(async ({ email, password }) => {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { userId: data.user && data.user.id };
  }, { email, password });
  if (res.error) throw new Error(`could not sign in as the sweep account — ${res.error}`);
  if (!res.userId) throw new Error('signed in but no user came back');
  return res.userId;
}

function listSites(page) {
  return page.evaluate(() =>
    SU_SITES.map(s => ({ key: s.key, label: suSiteLabel(s), home: s.home })));
}

// One جهة, in the page, through the app's own adapter. Its failure is returned
// rather than thrown: one site refusing is a hole in the answer, not the end of
// the sweep — the same rule the tab applies when an employee runs it.
async function scanSite(page, key, range) {
  return page.evaluate(async ({ key, range }) => {
    const site = SU_SITES.find(s => s.key === key);
    if (!site) return { ok: false, message: 'الجهة لم تعد في القائمة' };
    try {
      const res = await site.scan(range, () => {});
      return {
        ok: true,
        rows: res.rows || [],
        undated: (res.undated || []).length,
        scanned: res.scanned || 0,
      };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  }, { key, range });
}

async function main() {
  const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  const range = await decideRange(supabase);
  console.log(`sweeping ${range.from} → ${range.to}`);

  const browser = await launchBrowser();
  const results = [];
  let ownerId;
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'ar-SA',
      timezoneId: 'Asia/Riyadh',
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.on('pageerror', e => console.log(`  page error: ${e.message}`));

    await openApp(page);
    ownerId = await signIn(page, need('AUTO_SWEEP_EMAIL'), need('AUTO_SWEEP_PASSWORD'));

    const sites = await listSites(page);
    console.log(`${sites.length} جهة to read`);

    for (const site of sites) {
      const started = Date.now();
      let res;
      try {
        res = await Promise.race([
          scanSite(page, site.key, range),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('تجاوزت القراءة الوقت المسموح')), SITE_TIMEOUT_MS)),
        ]);
      } catch (e) {
        res = { ok: false, message: String((e && e.message) || e) };
      }
      const secs = Math.round((Date.now() - started) / 1000);
      if (res.ok) {
        console.log(`  ✓ ${site.label} — ${res.rows.length} في النطاق من ${res.scanned} (${secs}s)`);
      } else {
        console.log(`  ✗ ${site.label} — ${res.message} (${secs}s)`);
      }
      results.push({ site, ...res });
    }
  } finally {
    await browser.close();
  }

  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const itemCount = ok.reduce((n, r) => n + r.rows.length, 0);
  const undatedCount = ok.reduce((n, r) => n + r.undated, 0);

  // every جهة failing is not a sweep with nineteen holes, it is a sweep that did
  // not happen — recording it would move the range forward over days nothing
  // read, and the next run would never come back for them
  if (!ok.length) {
    throw new Error(`every جهة failed — ${failed.map(f => f.site.label).join('، ')}`);
  }

  const rows = ok.map(r => ({
    owner_id: ownerId,
    owner_name: 'بحث تلقائي',
    site_key: r.site.key,
    site_name: r.site.label,
    range_from: range.from,
    range_to: range.to,
    source_url: r.site.home,
    scanned_count: r.scanned,
    item_count: r.rows.length,
    items: r.rows,
    automatic: true,
  }));

  // one insert, so the nineteen rows share a created_at to within milliseconds
  // and the log groups them into the single line the sweep actually was
  const { error: rowsError } = await supabase.from('site_updates').insert(rows);
  if (rowsError) throw new Error(`could not save the coverage — ${rowsError.message}`);

  const { error: sweepError } = await supabase.from('auto_sweeps').insert({
    range_from: range.from,
    range_to: range.to,
    site_count: results.length,
    ok_count: ok.length,
    item_count: itemCount,
    undated_count: undatedCount,
    failures: failed.map(f => ({ label: f.site.label, message: f.message })),
  });
  if (sweepError) throw new Error(`could not record the sweep — ${sweepError.message}`);

  console.log(
    `swept ${ok.length}/${results.length} جهة — ${itemCount} تحديثًا` +
    (undatedCount ? `, ${undatedCount} بلا تاريخ` : '') +
    (failed.length ? `, ${failed.length} فشلت` : ''),
  );
}

main().catch(err => {
  // nothing recorded, so the range stays where it was and tomorrow's run comes
  // back for the same days rather than stepping over them
  console.error(String((err && err.message) || err));
  process.exit(1);
});
