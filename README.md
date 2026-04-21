# Kings Hotel Availability API

Microservicio Node.js + Puppeteer que expone la disponibilidad del motor de reservas de [Kings Hotel](https://www.kingshotel.com.ar) como una API REST limpia, ideal para integraciones con n8n, Make (Integromat), o cualquier cliente HTTP.

## Endpoints

### `GET /health`
```json
{ "status": "ok", "timestamp": "2026-05-01T12:00:00.000Z" }
```

### `GET /availability`

| Query param | Requerido | Formato      | Default | Descripción              |
|-------------|-----------|--------------|---------|--------------------------|
| `checkin`   | ✅        | `YYYY-MM-DD` | —       | Fecha de entrada         |
| `checkout`  | ✅        | `YYYY-MM-DD` | —       | Fecha de salida          |
| `adults`    | ❌        | entero       | `2`     | Cantidad de adultos      |
| `currency`  | ❌        | `ARS`/`USD`  | `ARS`   | Moneda de los precios    |

**Ejemplo:**
```
GET /availability?checkin=2026-05-10&checkout=2026-05-12&adults=2
```

**Respuesta con disponibilidad:**
```json
{
  "disponible": true,
  "checkin": "2026-05-10",
  "checkout": "2026-05-12",
  "noches": 2,
  "adults": 2,
  "habitaciones": [
    {
      "nombre": "Habitación Doble Matrimonial",
      "capacidad": "2 adultos",
      "precio": 45000,
      "moneda": "ARS",
      "link_reserva": "https://www.kingshotel.com.ar/lp.html?..."
    }
  ]
}
```

**Respuesta sin disponibilidad:**
```json
{
  "disponible": false,
  "checkin": "2026-05-10",
  "checkout": "2026-05-12",
  "noches": 2,
  "adults": 2,
  "habitaciones": []
}
```

**Respuesta de error** (siempre JSON válido):
```json
{
  "error": "Descripción del error",
  "disponible": false,
  "checkin": "2026-05-10",
  "checkout": "2026-05-12",
  "adults": 2,
  "habitaciones": []
}
```

---

## Deploy en Railway

### Opción A — Deploy con Dockerfile (recomendado)

1. Crear cuenta en [railway.app](https://railway.app)
2. Hacer click en **New Project → Deploy from GitHub repo**
3. Conectar este repositorio
4. Railway detecta el `Dockerfile` automáticamente
5. En **Variables**, agregar si es necesario:
   ```
   PORT=3000
   ```
6. El deploy queda listo. Railway asigna un dominio tipo:
   ```
   https://kingshotel-api-production.up.railway.app
   ```

### Opción B — Deploy con Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Variables de entorno en Railway

| Variable | Valor   | Descripción             |
|----------|---------|-------------------------|
| `PORT`   | `3000`  | Puerto (Railway lo setea automáticamente) |

> Railway inyecta `PORT` automáticamente, no hace falta configurarlo manualmente.

---

## Deploy en Render

1. Crear cuenta en [render.com](https://render.com)
2. **New → Web Service → Connect GitHub repo**
3. Configurar:
   - **Environment**: Docker
   - **Dockerfile Path**: `./Dockerfile`
4. En **Environment Variables**, agregar `PORT=3000` si es necesario
5. Click en **Deploy**

---

## Desarrollo local

```bash
# Instalar dependencias
npm install

# Copiar variables de entorno
cp .env.example .env

# Correr el servidor
npm start

# O con recarga automática
npm run dev
```

```bash
# Probar el endpoint
curl "http://localhost:3000/health"
curl "http://localhost:3000/availability?checkin=2026-05-10&checkout=2026-05-12&adults=2"
```

---

## Uso en n8n

En un nodo **HTTP Request**:

- **Method**: GET
- **URL**: `https://tu-servicio.up.railway.app/availability`
- **Query Parameters**:
  - `checkin`: `{{ $json.checkin }}` (o fecha fija)
  - `checkout`: `{{ $json.checkout }}`
  - `adults`: `2`

La respuesta es siempre JSON válido, incluso en caso de error, por lo que el workflow no se rompe.

---

## Notas técnicas

- Usa Puppeteer con Chromium headless en modo `--no-sandbox` para compatibilidad con contenedores Linux sin privilegios.
- El motor de reservas carga habitaciones vía AJAX (módulo `neo_modules/cart_hotel_v2`). Puppeteer espera a que el DOM se hidrate antes de extraer.
- Timeout máximo por request: **30 segundos**.
- Header `Access-Control-Allow-Origin: *` en todas las respuestas.
- Recursos no esenciales (imágenes, fuentes, analytics) son bloqueados para acelerar la carga.
