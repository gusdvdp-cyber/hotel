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
