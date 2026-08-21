/* ==========================================================================
   GET /api/poster  ->  image/png

   Renders the price-list poster by pointing a real headless Chrome at the
   site's own page and photographing it.

   WHY THIS EXISTS
   The poster used to be rasterised in the customer's browser by html2canvas,
   which does not screenshot the page - it re-implements the paint step and
   redraws a clone. Anything it models differently from Chrome comes out
   wrong in the file while looking perfect on screen. That produced a long
   tail of one-off fixes (no box-shadow, no object-fit, no elliptical
   gradients, no letter-spacing on Arabic, hand-rolled cover geometry, and a
   hand-calibrated pixel nudge to stop Tajawal's asymmetric line box pushing
   the price low in the pill).

   Here the renderer IS Chrome, so the PNG matches the page by construction
   and none of those workarounds are load-bearing any more.

   HOW IT STAYS HONEST
   It loads the real pricelist.html with ?fzexport=1 rather than rebuilding
   the markup server-side. There is exactly one poster implementation, so the
   image cannot drift from the site.
   ========================================================================== */

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { createHash } from 'node:crypto';

/* The poster stamps itself with "today". The page reads the clock of whatever
   machine renders it, and Vercel runs in UTC - so from 21:00 Cairo onwards an
   unpinned browser prints YESTERDAY's date on tonight's price list. Pin it. */
const TIMEZONE = 'Africa/Cairo';

/* Same publishable key the browser already ships in assets/js/config.js - it
   is public by design and guarded by RLS. Used here only to fingerprint the
   data, never to write. Keep in sync with that file. */
const SUPA_URL = 'https://gnlvytjcryizrkckpgtx.supabase.co';
const SUPA_KEY = 'sb_publishable_6Dgu7fTMdr1mqrUsHiiEQQ_GXZOXi91';

/* Matches CAPTURE_WIDTH / CAPTURE_SCALE in assets/js/poster.js: the poster's
   one true layout width, photographed at 3x -> a 1380px PNG. */
const WIDTH = 460;
const SCALE = 3;

/* The page is data-driven (Supabase) and pulls product photos and five font
   weights, so first paint is not the finish line. */
const READY_TIMEOUT = 30000;

/* Lambda keeps the container warm between calls; a browser that survives with
   it turns a ~4s cold start into ~1s. Never cached across a crash: any throw
   below disposes it so the next request builds a clean one. */
let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.connected) return b;
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: WIDTH, height: 1200, deviceScaleFactor: SCALE },
    executablePath: await chromium.executablePath(),
    headless: true
  });
  return browserPromise;
}

/* ---- result cache -------------------------------------------------------
   Rendering is ~11s because a whole browser has to load the page, the data,
   twelve product photos and five font weights. But the poster only changes
   when the prices, the product list or the day changes - and the owner
   typically downloads it several times in a row while sharing it around.

   So: fingerprint the inputs, and reuse the PNG while that fingerprint holds.
   Keyed on the data itself rather than on a timer, so a price edited in the
   dashboard is reflected on the very next download instead of after some
   arbitrary TTL. Lives in module scope, so it lasts as long as the warm
   container and costs nothing when cold. */
let cached = null; /* { key, png } */

function cairoDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

/* Returns null when it cannot be determined - the caller then just renders,
   because a missing fingerprint must cost speed, never correctness. */
async function dataFingerprint() {
  try {
    const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };
    const [settings, products] = await Promise.all([
      fetch(`${SUPA_URL}/rest/v1/market_settings?select=base_price&id=eq.1`, { headers })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`settings ${r.status}`)))),
      fetch(
        `${SUPA_URL}/rest/v1/products?select=id,name_ar,name_en,image_url,price,markup_type,markup_value,sort_order&is_available=eq.true&order=sort_order.asc`,
        { headers }
      ).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`products ${r.status}`))))
    ]);
    return createHash('sha1').update(`${cairoDay()}|${settings}|${products}`).digest('hex');
  } catch (e) {
    console.warn('poster fingerprint unavailable, rendering fresh:', e.message);
    return null;
  }
}

function sendPng(res, png, hit) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="fresh-zone-price-list-${cairoDay()}.png"`
  );
  /* Prices change during the day and the poster carries today's date, so the
     browser must never hold on to it; the server-side cache above is the one
     doing the reuse, and it knows when the data moved. */
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Poster-Cache', hit ? 'hit' : 'miss');
  return res.status(200).send(png);
}

function originOf(req) {
  /* Works unchanged on production, preview URLs and custom domains - never
     hardcode the host, or previews silently photograph production. */
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  let page;
  /* ?debug=1 reports what the page was doing instead of photographing it.
     A screenshot cannot tell you which promise never settled. */
  const debug = /[?&]debug=1(?:&|$)/.test(req.url || '');
  const logs = [];
  const failed = [];
  try {
    /* Ask before building: on a warm container an unchanged poster comes back
       in a few hundred milliseconds instead of eleven seconds. */
    const key = await dataFingerprint();
    if (!debug && key && cached && cached.key === key) {
      return sendPng(res, cached.png, true);
    }

    const browser = await getBrowser();
    page = await browser.newPage();
    await page.emulateTimezone(TIMEZONE);

    if (debug) {
      page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
      page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`.slice(0, 300)));
      page.on('requestfailed', (r) =>
        failed.push(`${r.failure()?.errorText} ${r.url()}`.slice(0, 200)));
    }
    await page.setViewport({ width: WIDTH, height: 1200, deviceScaleFactor: SCALE });
    /* A backgrounded tab has rAF suspended and paints lazily. The page guards
       against that too, but a foreground tab is the condition its timings were
       written for. */
    await page.bringToFront();

    const target = `${originOf(req)}/pricelist.html?fzexport=1`;

    /* Deployment Protection stands between this function and its own site on
       protected deployments (previews, by default): the browser is handed
       Vercel's login page instead of the poster. Vercel issues a bypass
       secret for exactly this; send it when the project has one, and simply
       carry on when it does not - unprotected production needs no header. */
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) {
      await page.setExtraHTTPHeaders({ 'x-vercel-protection-bypass': bypass });
    }

    /* domcontentloaded, not networkidle0: the page raises its own readiness
       flag once data, images and fonts have all settled, which is a stronger
       guarantee than "the network went quiet" and does not wait on anything
       irrelevant. */
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT });

    /* Name this failure instead of letting it look like a slow page: if the
       poster script is not on the document, we were served something else -
       almost always an auth wall - and waiting 30s would tell nobody why. */
    const isPosterPage = await page.evaluate(
      () => !!document.querySelector('script[src*="poster.js"], #poster')
    );
    if (!isPosterPage) {
      throw new Error(
        `did not receive the poster page (likely Deployment Protection on ${target}); ` +
        'enable Protection Bypass for Automation, or use an unprotected deployment'
      );
    }

    try {
      await page.waitForFunction(
        'window.__fzPosterReady === true || typeof window.__fzPosterError === "string"',
        { timeout: READY_TIMEOUT, polling: 100 }
      );
    } catch (waitErr) {
      if (!debug) throw waitErr;
      /* Report where it stalled rather than just that it did. */
      const state = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('.pphoto img'));
        return {
          ready: window.__fzPosterReady === true,
          pageError: window.__fzPosterError || null,
          hasFZ: !!window.FZ,
          hasSupabaseLib: !!window.supabase,
          hasClient: window.FZ && window.FZ.client ? !!window.FZ.client() : null,
          rows: document.querySelectorAll('.prow').length,
          imgTotal: imgs.length,
          imgLoaded: imgs.filter((i) => i.complete && i.naturalWidth).length,
          fontsStatus: document.fonts ? document.fonts.status : 'n/a',
          visibility: document.visibilityState,
          listMsg: (document.querySelector('.plist-msg') || {}).textContent || null
        };
      }).catch((e) => ({ evaluateFailed: String(e) }));

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.status(200).send(JSON.stringify(
        { stalled: true, state, logs: logs.slice(-40), failedRequests: failed.slice(-30) },
        null, 2
      ));
    }

    /* The page reports its own failures, so a broken price list becomes a
       clear 502 instead of a photograph of an error message. */
    const pageError = await page.evaluate(() => window.__fzPosterError || null);
    if (pageError) throw new Error(`poster page failed: ${pageError}`);

    const el = await page.$('.poster');
    if (!el) throw new Error('poster element not found');

    /* Grow the viewport to the whole poster before shooting. Capturing past
       the viewport edge is the flakier path across Puppeteer versions, and a
       poster taller than the window is the normal case - the product list
       decides the height. */
    const height = await page.evaluate(
      () => Math.ceil(document.querySelector('.poster').getBoundingClientRect().height)
    );
    await page.setViewport({ width: WIDTH, height: height + 40, deviceScaleFactor: SCALE });

    const png = await el.screenshot({ type: 'png' });

    if (key) cached = { key, png };
    return sendPng(res, png, false);
  } catch (err) {
    console.error('poster export failed:', err);
    /* Plain text, and never image/png: the client checks the MIME type and
       falls back to browser rendering, so a JSON body typed as an image
       would be "downloaded" as a corrupt file. */
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(502).send(`poster export failed: ${err.message}`);
  } finally {
    if (page) {
      /* Close the tab, keep the browser: leaked pages are what turns a warm
         container into an out-of-memory one. */
      try { await page.close(); } catch (e) { /* already gone */ }
    }
  }
}
