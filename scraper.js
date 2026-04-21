const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const TIMEOUT_MS = 55000;
const BASE_URL = 'https://www.kingshotel.com.ar/lp.html';

function randomSearchId() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

function calcNights(checkin, checkout) {
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

// YYYY-MM-DD → DD/MM/YYYY (Argentine datepicker format)
function toARDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.,]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  } else if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts[parts.length - 1].length === 3) return parseFloat(cleaned.replace(/\./g, ''));
    return parseFloat(cleaned);
  } else if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    if (parts[parts.length - 1].length === 3) return parseFloat(cleaned.replace(/,/g, ''));
    return parseFloat(cleaned.replace(',', '.'));
  }
  return parseFloat(cleaned);
}

// Wait for the booking engine to finish loading (loader gone + no intermediate states)
async function waitForSearchComplete(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const loader = document.querySelector('.neo_loader');
      const loaderGone = !loader || window.getComputedStyle(loader).display === 'none';
      if (!loaderGone) return false;
      // Check that the module container is visible and not in a "Loading" shimmer state
      const mega = document.querySelector('.neo_megacontainer');
      if (!mega || window.getComputedStyle(mega).display === 'none') return false;
      // Loading shimmer → still running
      const shimmer = document.querySelector('.Loading .linear-activity');
      if (shimmer && window.getComputedStyle(shimmer).display !== 'none') return false;
      // Either rooms or no-inventory must be present
      const rooms = document.querySelectorAll('.ListItem_Sku');
      if (rooms.length > 0) return true;
      const noInv = document.querySelector('#no-inventory-container');
      if (noInv) return true;
      return false;
    },
    { timeout: timeoutMs }
  );
}

async function scrapeAvailability({ checkin, checkout, adults = 2, currency = 'ARS' }) {
  const searchId = randomSearchId();
  const nights = calcNights(checkin, checkout);
  const checkinAR = toARDate(checkin);
  const checkoutAR = toARDate(checkout);

  const url =
    `${BASE_URL}?search=OK&pos=KingsHotel&SearchID=${searchId}` +
    `&cur=${currency}&lng=es&Pid=8616` +
    `&checkin=${checkin}&checkout=${checkout}`;

  const reserveBase =
    `${BASE_URL}?search=OK&pos=KingsHotel&SearchID=${searchId}` +
    `&cur=${currency}&lng=es&Pid=8616` +
    `&checkin=${checkin}&checkout=${checkout}`;

  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      timeout: TIMEOUT_MS,
    });

    const page = await browser.newPage();

    // Stub analytics before any scripts run — prevents "ga is not defined" crashes
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.ga = function() {};
      window.gtag = function() {};
      window.dataLayer = window.dataLayer || [];
    });

    // Block analytics & ads network calls (speeds up page load significantly)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const u = req.url();
      if (
        type === 'image' ||
        type === 'font' ||
        type === 'media' ||
        u.includes('googletagmanager.com') ||
        u.includes('google-analytics.com') ||
        u.includes('analytics.google.com') ||
        u.includes('google.com/rmkt') ||
        u.includes('google.com/measurement') ||
        u.includes('google.com/ccm') ||
        u.includes('googleadservices.com') ||
        u.includes('facebook.net') ||
        u.includes('chat-widget') ||
        u.includes('cdn-cgi/rum')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // ── Pass 1: load with search=OK (engine auto-submits with today's date) ──
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for first search to fully complete
    await waitForSearchComplete(page, 20000).catch(() => null);

    // ── Pass 2: set correct dates in the still-live form and resubmit ────────
    const setResult = await page.evaluate(
      ({ checkinAR, checkoutAR, adults }) => {
        if (!window.jQuery) return 'no jQuery';
        const $ = window.jQuery;

        // The datepicker is now initialized — safe to overwrite its inputs
        const setDP = (selector, value) => {
          const el = $(selector);
          if (!el.length) return false;
          try { el.datepicker('setDate', value); } catch (e) {}
          el.val(value);
          return true;
        };

        setDP('#Start, [name="Start"], .fechas_ancho_entrada input', checkinAR);
        setDP('#End,   [name="End"],   .fechas_ancho_salida input',  checkoutAR);

        // Adults
        const n = parseInt(adults, 10);
        $('.numberAdults').text(n);
        $('[name="GroupsForm"], [name="adults"], #adults').val(n);

        // Click the search button
        const btn = $(
          '#btn_buscar, .boton_buscar, button[type="submit"], ' +
          'input[type="submit"], button:contains("Buscar"), ' +
          'a.boton_buscar, .neo_btn_search'
        );
        if (btn.length) { btn.first().trigger('click'); return 'clicked:' + btn.first().attr('class'); }

        // Fallback: submit the form directly
        $('#pxmk_searchform').submit();
        return 'form.submit()';
      },
      { checkinAR, checkoutAR, adults }
    );

    console.log('[scraper] pass2 submit:', setResult);

    // Wait for second search to complete
    await waitForSearchComplete(page, 20000).catch(() => null);

    // ── Extract ───────────────────────────────────────────────────────────────
    const hasRooms = (await page.$$('.ListItem_Sku')).length > 0;

    if (!hasRooms) {
      return { disponible: false, checkin, checkout, noches: nights, adults, habitaciones: [] };
    }

    const habitaciones = await page.evaluate(
      ({ reserveBase, adults }) => {
        const results = [];
        document.querySelectorAll('.ListItem_Sku').forEach((item) => {
          const nameEl =
            item.querySelector('.ListItem_Titulo') ||
            item.querySelector('.neo_cart_title') ||
            item.querySelector('h2') || item.querySelector('h3');
          const nombre = nameEl ? nameEl.textContent.trim() : 'Habitación';

          const priceEl =
            item.querySelector('.ListItem_promotionalrate') ||
            item.querySelector('.pricepreview_now') ||
            item.querySelector('.neo_sku_pricepreview') ||
            item.querySelector('.NightsTotalRate');
          const precioRaw = priceEl ? priceEl.textContent.trim() : '';

          let moneda = 'ARS';
          if (precioRaw.toUpperCase().includes('USD')) moneda = 'USD';

          const capEl =
            item.querySelector('.pref_cama') ||
            item.querySelector('.neo_amenity_item') ||
            item.querySelector('[class*="capacidad"]');
          let capacidad = capEl ? capEl.textContent.trim() : `${adults} adultos`;
          if (!capacidad || capacidad.length > 50) capacidad = `${adults} adultos`;

          const linkEl =
            item.querySelector('a.boton') ||
            item.querySelector('a[href*="checkout"]') ||
            item.querySelector('a[href*="reserva"]') ||
            item.querySelector('.button_list_c a');
          const link_reserva = (linkEl && linkEl.href && linkEl.href.startsWith('http'))
            ? linkEl.href : reserveBase;

          results.push({ nombre, capacidad, precioRaw, moneda, link_reserva });
        });
        return results;
      },
      { reserveBase, adults }
    );

    const habitacionesClean = habitaciones.map((h) => ({
      nombre: h.nombre,
      capacidad: h.capacidad,
      precio: parsePrice(h.precioRaw),
      moneda: h.moneda,
      link_reserva: h.link_reserva,
    }));

    return {
      disponible: habitacionesClean.length > 0,
      checkin,
      checkout,
      noches: nights,
      adults,
      habitaciones: habitacionesClean,
    };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeAvailability };
