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

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

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

function originOf(req) {
  /* Works unchanged on production, preview URLs and custom domains - never
     hardcode the host, or previews silently photograph production. */
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

module.exports = async (req, res) => {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: 1200, deviceScaleFactor: SCALE });

    const target = `${originOf(req)}/pricelist.html?fzexport=1`;

    /* domcontentloaded, not networkidle0: the page raises its own readiness
       flag once data, images and fonts have all settled, which is a stronger
       guarantee than "the network went quiet" and does not wait on anything
       irrelevant. */
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT });

    await page.waitForFunction(
      'window.__fzPosterReady === true || typeof window.__fzPosterError === "string"',
      { timeout: READY_TIMEOUT, polling: 100 }
    );

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

    res.setHeader('Content-Type', 'image/png');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="fresh-zone-price-list-${new Date().toISOString().slice(0, 10)}.png"`
    );
    /* Prices change during the day and the poster is stamped with today's
       date, so this must never be served stale. */
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).send(png);
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
};
