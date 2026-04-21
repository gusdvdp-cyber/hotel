const express = require('express');
const { scrapeAvailability } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS — allow n8n and any frontend to call freely ────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Always respond with JSON
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});

// ─── /health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── /debug-page — intercept XHR to find the real API the booking engine uses ─
app.get('/debug-page', async (req, res) => {
  const puppeteer = require('puppeteer-core');
  const chromium = require('@sparticuz/chromium');
  const { checkin = '2026-06-15', checkout = '2026-06-17' } = req.query;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();

    // Capture all XHR/fetch responses to find the real data API
    const xhrCalls = [];
    page.on('response', async (response) => {
      const url = response.url();
      const type = response.request().resourceType();
      if ((type === 'xhr' || type === 'fetch') && url.includes('kingshotel')) {
        try {
          const body = await response.text().catch(() => '');
          xhrCalls.push({
            url,
            status: response.status(),
            bodySnippet: body.substring(0, 500),
          });
        } catch (_) {}
      }
    });

    const sid = Math.floor(10000000 + Math.random() * 90000000);
    const url = `https://www.kingshotel.com.ar/lp.html?search=OK&pos=KingsHotel&SearchID=${sid}&cur=ARS&lng=es&Pid=8616&checkin=${checkin}&checkout=${checkout}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for loader to disappear
    await page.waitForFunction(
      () => { const l = document.querySelector('.neo_loader'); return !l || window.getComputedStyle(l).display === 'none'; },
      { timeout: 20000 }
    ).catch(() => null);

    // Extra wait for AJAX
    await new Promise(r => setTimeout(r, 8000));

    const domInfo = await page.evaluate(() => ({
      listItemCount: document.querySelectorAll('.ListItem_Sku').length,
      AlmostReadyHTML: document.querySelector('.AlmostReady')?.innerHTML?.substring(0, 1000) || null,
      LoadingHTML: document.querySelector('.Loading')?.innerHTML?.substring(0, 500) || null,
      bodyEnd: document.body.innerHTML.slice(-2000),
    }));

    res.json({ xhrCalls, domInfo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── /debug — test Puppeteer launch only (remove after fix) ──────────────────
app.get('/debug', async (req, res) => {
  const puppeteer = require('puppeteer-core');
  const chromium = require('@sparticuz/chromium');
  const info = { browserLaunch: null, error: null };

  try {
    info.executablePath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: info.executablePath,
      headless: chromium.headless,
    });
    info.browserVersion = await browser.version();
    await browser.close();
    info.browserLaunch = 'OK';
  } catch (e) {
    info.browserLaunch = 'FAILED';
    info.error = e.message;
  }

  res.json(info);
});

// ─── /availability ───────────────────────────────────────────────────────────
app.get('/availability', async (req, res) => {
  const { checkin, checkout, adults: adultsRaw = '2', currency = 'ARS' } = req.query;

  // ── Validate required params ──────────────────────────────────────────────
  if (!checkin || !checkout) {
    return res.status(400).json({
      error: 'Parámetros requeridos: checkin y checkout (formato YYYY-MM-DD)',
    });
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(checkin) || !dateRegex.test(checkout)) {
    return res.status(400).json({
      error: 'Las fechas deben tener formato YYYY-MM-DD',
    });
  }

  const checkinDate = new Date(checkin);
  const checkoutDate = new Date(checkout);

  if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime())) {
    return res.status(400).json({ error: 'Fechas inválidas' });
  }

  if (checkoutDate <= checkinDate) {
    return res.status(400).json({
      error: 'checkout debe ser posterior a checkin',
    });
  }

  const adults = parseInt(adultsRaw, 10);
  if (isNaN(adults) || adults < 1) {
    return res.status(400).json({ error: 'adults debe ser un número entero positivo' });
  }

  // ── Run scraper with 30s hard timeout ─────────────────────────────────────
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout: la consulta tardó más de 30 segundos')), 30000)
  );

  try {
    const result = await Promise.race([
      scrapeAvailability({ checkin, checkout, adults, currency }),
      timeoutPromise,
    ]);

    return res.json(result);
  } catch (err) {
    console.error('[availability] Error:', err.message);
    return res.status(500).json({
      error: err.message || 'Error interno al consultar disponibilidad',
      disponible: false,
      checkin,
      checkout,
      adults,
      habitaciones: [],
    });
  }
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Kings Hotel Availability API corriendo en puerto ${PORT}`);
  console.log(`  GET /health`);
  console.log(`  GET /availability?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&adults=2`);
});
