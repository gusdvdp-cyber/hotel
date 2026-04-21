const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const TIMEOUT_MS = 30000;
const BASE_URL = 'https://www.kingshotel.com.ar/lp.html';

function randomSearchId() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

function calcNights(checkin, checkout) {
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

// YYYY-MM-DD → DD/MM/YYYY (formato datepicker argentino)
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

async function scrapeAvailability({ checkin, checkout, adults = 2, currency = 'ARS' }) {
  const searchId = randomSearchId();
  const nights = calcNights(checkin, checkout);

  // Load WITHOUT search=OK so the form doesn't auto-submit before we set the dates
  const url =
    `${BASE_URL}?pos=KingsHotel&SearchID=${searchId}` +
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

    // Block non-essential resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const u = req.url();
      if (
        type === 'image' ||
        type === 'font' ||
        type === 'media' ||
        u.includes('facebook') ||
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

    // Hide webdriver flag + stub analytics to prevent "ga is not defined" crashes
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // The booking engine calls ga() internally — stub it so it doesn't throw
      window.ga = window.ga || function() {};
      window.gtag = window.gtag || function() {};
      window.dataLayer = window.dataLayer || [];
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

    // Wait for the neo_loader to disappear (page structure ready)
    await page.waitForFunction(
      () => {
        const l = document.querySelector('.neo_loader');
        return !l || window.getComputedStyle(l).display === 'none';
      },
      { timeout: 20000 }
    ).catch(() => null);

    // Wait for the search form and the datepicker to be initialized
    await page.waitForSelector('#pxmk_searchform, form[id*="search"]', { timeout: 10000 })
      .catch(() => null);

    // Extra wait for jQuery + datepicker to finish initializing
    await new Promise(r => setTimeout(r, 2000));

    // Set the correct dates via jQuery (overrides datepicker defaults)
    const checkinAR = toARDate(checkin);
    const checkoutAR = toARDate(checkout);

    const formSet = await page.evaluate(
      ({ checkinAR, checkoutAR, checkin, checkout, adults }) => {
        const log = [];
        if (!window.jQuery) return { ok: false, reason: 'no jQuery' };
        const $ = window.jQuery;

        // The datepicker uses text inputs — try every known selector
        const setInput = (selector, value) => {
          const el = $(selector);
          if (el.length) {
            el.val(value).trigger('change').trigger('input');
            log.push(`set ${selector} = ${value}`);
            return true;
          }
          return false;
        };

        // Start date (checkin)
        setInput('#Start', checkinAR) ||
        setInput('input[name="Start"]', checkinAR) ||
        setInput('.fechas_ancho_entrada input', checkinAR) ||
        setInput('input.fechaintxt:first', checkinAR);

        // End date (checkout)
        setInput('#End', checkoutAR) ||
        setInput('input[name="End"]', checkoutAR) ||
        setInput('.fechas_ancho_salida input', checkoutAR) ||
        setInput('input.fechaintxt:last', checkoutAR);

        // Adults — update the counter display and hidden input
        const adultsNum = parseInt(adults, 10);
        $('.numberAdults').text(adultsNum);
        $('input[name="adults"], input[name="Adults"], #adults').val(adultsNum);

        // Also try to set via the PartyType inputs
        $('input[name="GroupsForm"]').val(adultsNum);

        log.push(`adults set to ${adultsNum}`);

        return { ok: true, log };
      },
      { checkinAR, checkoutAR, checkin, checkout, adults }
    );

    console.log('[scraper] form set:', JSON.stringify(formSet));

    // Submit the search form
    await page.evaluate(() => {
      const $ = window.jQuery;
      if ($) {
        // Try clicking the search button first
        const btn = $('button[type="submit"], input[type="submit"], .boton_buscar, #btn_buscar, button:contains("Buscar"), input[value*="uscar"]');
        if (btn.length) {
          btn.first().click();
          return 'clicked button';
        }
        // Fallback: submit form directly
        $('#pxmk_searchform').submit();
        return 'form.submit()';
      }
      return 'no jQuery';
    });

    // Wait for the loader to reappear (search started) then disappear (results ready)
    await new Promise(r => setTimeout(r, 1000));

    await page.waitForFunction(
      () => {
        const l = document.querySelector('.neo_loader');
        return !l || window.getComputedStyle(l).display === 'none';
      },
      { timeout: 20000 }
    ).catch(() => null);

    // Wait for rooms or no-inventory
    await page.waitForFunction(
      () => {
        const rooms = document.querySelectorAll('.ListItem_Sku');
        if (rooms.length > 0) return true;
        const noInv = document.querySelector('#no-inventory-container, #no-inventory');
        if (noInv && window.getComputedStyle(noInv).display !== 'none') return true;
        // Also check AlmostReady is gone
        const almost = document.querySelector('.AlmostReady');
        if (!almost) return true;
        return false;
      },
      { timeout: 20000 }
    ).catch(() => null);

    await new Promise(r => setTimeout(r, 1000));

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
            item.querySelector('h2') ||
            item.querySelector('h3');
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
          const link_reserva = linkEl
            ? (linkEl.href.startsWith('http') ? linkEl.href : reserveBase)
            : reserveBase;

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
