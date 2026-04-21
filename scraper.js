const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const TIMEOUT_MS = 30000;
const BASE_URL = 'https://www.kingshotel.com.ar/lp.html';

/**
 * Generates a random 8-digit SearchID
 */
function randomSearchId() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

/**
 * Calculates nights between two YYYY-MM-DD dates
 */
function calcNights(checkin, checkout) {
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

/**
 * Parses a price string like "$ 45.000" or "ARS 45,000" into a number
 */
function parsePrice(raw) {
  if (!raw) return null;
  // Remove currency symbols, letters, spaces — keep digits, dot, comma
  const cleaned = raw.replace(/[^0-9.,]/g, '').trim();
  if (!cleaned) return null;
  // Argentine format: 45.000 = 45000, or 45,000 = 45000
  // Could also be 45.000,50 (with cents)
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // Format: 45.000,50 — dot is thousands separator, comma is decimal
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  } else if (cleaned.includes('.')) {
    // Could be 45.000 (thousands) or 45.50 (decimal)
    const parts = cleaned.split('.');
    if (parts[parts.length - 1].length === 3) {
      // Last segment is 3 digits → thousands separator
      return parseFloat(cleaned.replace(/\./g, ''));
    }
    return parseFloat(cleaned);
  } else if (cleaned.includes(',')) {
    // 45,000 → thousands separator or 45,50 → decimal
    const parts = cleaned.split(',');
    if (parts[parts.length - 1].length === 3) {
      return parseFloat(cleaned.replace(/,/g, ''));
    }
    return parseFloat(cleaned.replace(',', '.'));
  }
  return parseFloat(cleaned);
}

/**
 * Main scraper function
 * @param {string} checkin  - YYYY-MM-DD
 * @param {string} checkout - YYYY-MM-DD
 * @param {number} adults   - number of adults
 * @param {string} currency - currency code (default ARS)
 * @returns {object} availability result
 */
async function scrapeAvailability({ checkin, checkout, adults = 2, currency = 'ARS' }) {
  const searchId = randomSearchId();
  const nights = calcNights(checkin, checkout);

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

    // Block unnecessary resources to speed up scraping
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      // Block images, fonts, analytics — but allow scripts and XHR needed for booking engine
      if (
        type === 'image' ||
        type === 'font' ||
        type === 'media' ||
        url.includes('googletagmanager') ||
        url.includes('google-analytics') ||
        url.includes('facebook') ||
        url.includes('chat-widget')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate — domcontentloaded is enough since we wait for JS separately
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });

    // Step 1: wait for the loading spinner (.neo_loader) to disappear.
    // This signals that the booking engine JS finished its AJAX call and rendered results.
    await page.waitForFunction(
      () => {
        const loader = document.querySelector('.neo_loader');
        if (!loader) return true;
        const s = window.getComputedStyle(loader);
        return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0';
      },
      { timeout: TIMEOUT_MS }
    );

    // Step 2: wait for the content container to become visible
    await page.waitForFunction(
      () => {
        const c = document.querySelector('.neo_megacontainer');
        if (!c) return false;
        return window.getComputedStyle(c).display !== 'none';
      },
      { timeout: TIMEOUT_MS }
    ).catch(() => null); // non-fatal — proceed anyway

    const ROOM_SELECTOR = '.ListItem_Sku';

    // Step 3: brief extra wait for any late-rendering room cards
    await new Promise(r => setTimeout(r, 1500));

    let hasRooms = false;
    try {
      hasRooms = (await page.$$(ROOM_SELECTOR)).length > 0;
    } catch (_) {
      hasRooms = false;
    }

    if (!hasRooms) {
      return {
        disponible: false,
        checkin,
        checkout,
        noches: nights,
        adults,
        habitaciones: [],
      };
    }

    // Extract room data
    const habitaciones = await page.evaluate(
      ({ reserveBase, adults }) => {
        const items = document.querySelectorAll('.ListItem_Sku');
        const results = [];

        items.forEach((item) => {
          // Room name — try multiple selectors in order of specificity
          const nameEl =
            item.querySelector('.ListItem_Titulo') ||
            item.querySelector('.neo_cart_title') ||
            item.querySelector('.sku_main_description h2') ||
            item.querySelector('h2') ||
            item.querySelector('h3');
          const nombre = nameEl ? nameEl.textContent.trim() : 'Habitación';

          // Price — try promotional rate first, then regular
          const priceEl =
            item.querySelector('.ListItem_promotionalrate') ||
            item.querySelector('.pricepreview_now') ||
            item.querySelector('.neo_sku_pricepreview') ||
            item.querySelector('.NightsTotalRate');
          const precioRaw = priceEl ? priceEl.textContent.trim() : '';

          // Currency detection from price text or data attribute
          let moneda = 'ARS';
          if (precioRaw.toUpperCase().includes('USD')) moneda = 'USD';

          // Capacity — look for bed/adult info
          const capEl =
            item.querySelector('.pref_cama') ||
            item.querySelector('.neo_amenity_item') ||
            item.querySelector('[class*="capacidad"]') ||
            item.querySelector('[class*="adultos"]');
          let capacidad = capEl ? capEl.textContent.trim() : `${adults} adultos`;
          if (!capacidad || capacidad.length > 50) {
            capacidad = `${adults} adultos`;
          }

          // Reserve link — look for anchor with booking href, or construct it
          const linkEl =
            item.querySelector('a.boton') ||
            item.querySelector('a[href*="checkout"]') ||
            item.querySelector('a[href*="reserva"]') ||
            item.querySelector('a[href*="booking"]') ||
            item.querySelector('.button_list_c a');
          const link_reserva = linkEl
            ? linkEl.href || reserveBase
            : reserveBase;

          results.push({
            nombre,
            capacidad,
            precioRaw,
            moneda,
            link_reserva: link_reserva.startsWith('http') ? link_reserva : reserveBase,
          });
        });

        return results;
      },
      { reserveBase, adults }
    );

    // Parse prices in Node context (not in browser evaluate)
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
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { scrapeAvailability };
