# FICHA TÉCNICA · CDN (dramatico.inaem.gob.es) — CERRADA

## 1) URLs de listado

- `https://dramatico.inaem.gob.es/programacion/`
- `https://dramatico.inaem.gob.es/programacion/teatro-maria-guerrero/`
- `https://dramatico.inaem.gob.es/programacion/teatro-valle-inclan/`

## 2) Listados y paginación

### A) `/programacion/`

- **¿Paginación?** Sí, tratada por fallback AJAX mensual (no por `page/2` en este scraper).
- **Tipo:** `POST /wp-admin/admin-ajax.php` con `action=get-cdn-events|get_cdn_events`, parámetros `mes`, `year`.
- **URL página 2:** No aplica en formato path/query dentro del scraper actual; el equivalente funcional es “siguiente mes”.
- **Máximo real/estimado:** 2 meses (mes actual + siguiente), según implementación de fallback.
- **Selector `next`:** No usado en este flujo.
- **Selector de tarjeta/item (HTML):** `div.item.item-event-resume.evento-programacion`
- **Selector título+link (`/evento/*`):** `.wrapper-detail .detail h2 a[href*='/evento/']`
- **Selector fecha/rango en listado:** dentro de `.wrapper-detail .detail p` (regex `DD MON - DD MON`)
- **Selector horario en listado:** no fijo en card; se completa en ficha `/evento/*` (panel izquierdo).
- **Selector autor/dirección en listado:** parse textual de `.wrapper-detail .detail p`
- **Selector imagen listado:** `.carousel-inner img` con fallback a primer `img`

### B) `/programacion/teatro-maria-guerrero/`

- **¿Paginación?** Misma estrategia: HTML directo + fallback AJAX mensual.
- **Tipo:** HTML cards + `admin-ajax.php`.
- **URL página 2:** No aplica como URL paginada en código actual; se usa siguiente mes en fallback.
- **Máximo real/estimado:** 2 meses en fallback.
- **Selector `next`:** No usado.
- **Selector tarjeta/item:** `div.item.item-event-resume.evento-programacion`
- **Selector título+link:** `.wrapper-detail .detail h2 a[href*='/evento/']`
- **Selector fecha/rango listado:** `<p>` de detail (regex)
- **Selector horario listado:** no dedicado; horario sólido en ficha `/evento/*`
- **Selector autor/dirección listado:** parse textual en `<p>` del detail
- **Selector imagen:** `.carousel-inner img`, fallback `img`

### C) `/programacion/teatro-valle-inclan/`

- **¿Paginación?** Misma estrategia: HTML + fallback AJAX mensual.
- **Tipo:** HTML cards + `admin-ajax.php`.
- **URL página 2:** No aplica como URL `page/2`; siguiente bloque por mes.
- **Máximo real/estimado:** 2 meses en fallback.
- **Selector `next`:** No usado.
- **Selector tarjeta/item:** `div.item.item-event-resume.evento-programacion`
- **Selector título+link:** `.wrapper-detail .detail h2 a[href*='/evento/']`
- **Selector fecha/rango listado:** `<p>` de detail (regex)
- **Selector horario listado:** en ficha `/evento/*` panel izquierdo
- **Selector autor/dirección listado:** parse textual en `<p>` del detail
- **Selector imagen:** `.carousel-inner img`, fallback `img`

## 3) Ficha `/evento/*`

- **Ejemplo MG (patrón):** `https://dramatico.inaem.gob.es/evento/...` (source `cdn-maria-guerrero`)
- **Ejemplo VI (patrón):** `https://dramatico.inaem.gob.es/evento/...` (source `cdn-valle-inclan`)

### Selectores exactos en ficha

- **Rango + horario (panel izquierdo):**
  - contenedor: `div.col-lg-5.col-left .box-title .detail > p`
  - rango: `strong` dentro de ese `p`
  - horario: líneas del mismo `p` (normalizando `<br>`)

- **Equipo (autor/director/otros):**
  - `div.equipo.box-line .content .item`
  - `h4` como etiqueta, `p` como valor

- **Imagen principal:**
  - `meta[property='og:image']`
  - fallback: `meta[name='twitter:image']`

- **JSON-LD:**
  - `script[type='application/ld+json']`
  - soporta array y `@graph`

## 4) Bloqueos y fallback

- En este entorno de ejecución, accesos salientes a `dramatico.inaem.gob.es` y `r.jina.ai` pueden devolver `CONNECT tunnel failed, response 403`.
- El scraper contempla defensa por capas:
  1. acceso directo,
  2. fallback `r.jina.ai/http(s)://...`,
  3. fallback AJAX mensual (`admin-ajax.php`).

## 5) Correspondencia con implementación

Esta ficha está alineada con la implementación actual de `scripts/update-cartelera-weekly.js` para:
- scrape de cards en listados de programación,
- fallback mensual por admin-ajax,
- enriquecimiento desde ficha `/evento/*`.
