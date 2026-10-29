// Comida: registro de alimentos y micronutrientes dentro de Mi Garmin (tipo Macro).
//   GET  /comida                 → la app de comida (requiere sesión)
//   GET  /comida/foods.json      → base de alimentos (básicos USDA + tus marcas, suplementos y recetas)
//   GET  /api/food/log?from=&to= → registros (por defecto, últimos 45 días)
//   POST /api/food/log           → añade o cambia un registro {id?, date, meal, fid, name, brand, qty, pn, f, nut}
//   DELETE /api/food/log?id=     → borra un registro
//   GET/POST/DELETE /api/food/custom → tus alimentos y recetas creados en la app
//   GET/PUT /api/food/goals      → objetivos (kcal fijas o según el gasto de Garmin, proteína g/kg, reparto)
//   GET/POST /api/food/water     → agua del día (la misma medida "agua", en litros, que la pestaña Medidas)
//   GET  /api/food/barcode?code= → busca un código de barras en Open Food Facts
//   GET  /api/food/export        → el Mac descarga todo (Authorization: Bearer UPLOAD_TOKEN)
//   /comida/mcp (+ OAuth)        → conector de Claude para apuntar hablando, sin el Mac (comida/mcp.js)
// Cada cambio actualiza también las medidas del día "kcal" y "proteina" del registro, para que el panel las reciba como hasta ahora.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function comida({ DATA_DIR, LOG_FILE, send, json, readBody, readJson, writeAtomic }) {
  const PUB = path.join(__dirname, 'public');
  const FLOG = path.join(DATA_DIR, 'food_log.json');       // { id: entrada }
  const FCUSTOM = path.join(DATA_DIR, 'food_custom.json'); // { id: alimento }
  const FGOALS = path.join(DATA_DIR, 'food_goals.json');
  const NUT_KEYS = JSON.parse(fs.readFileSync(path.join(PUB, 'foods.json'), 'utf8')).nutrients.map(n => n.k);
  const MEALS = ['desayuno', 'comida', 'merienda', 'cena', 'snacks', 'suplementos'];
  const DEFAULT_GOALS = { mode: 'garmin', kcal: 1800, adjust: 0, protein_gkg: 1.6, weight: 60, fat_pct: 30, show_micros: true, water_l: 2 };
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const str = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);
  const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null; };
  const cleanNut = o => {
    const out = {};
    for (const k of NUT_KEYS) { const v = num(o?.[k], 0, 1e6); if (v != null) out[k] = Math.round(v * 1e4) / 1e4; }
    return out;
  };
  const cleanFood = b => ({
    id: typeof b.id === "string" && /^c-[a-z0-9-]{4,60}$/.test(b.id) ? b.id : 'c-' + crypto.randomBytes(6).toString('hex'),
    n: str(b.n, 80) || 'Sin nombre', brand: str(b.brand, 60), g: str(b.g, 40) || (b.recipe ? 'Recetas' : 'Mis alimentos'),
    src: str(b.src, 80) || 'creado en la app', base: str(b.base, 30) || '100 g', nut: cleanNut(b.nut),
    pt: (Array.isArray(b.pt) ? b.pt : []).slice(0, 12).map(p => ({ n: str(p.n, 40), f: num(p.f, 0, 1e4) || 1 })),
    code: str(b.code, 20), mine: true, recipe: !!b.recipe,
    items: b.recipe && Array.isArray(b.items) ? b.items.slice(0, 40).map(i => ({ fid: str(i.fid, 70), name: str(i.name, 80), qty: num(i.qty, 0, 1e4), pn: str(i.pn, 40), f: num(i.f, 0, 1e4) })) : undefined,
    servings: b.recipe ? num(b.servings, 1, 100) || 1 : undefined,
    ts: new Date().toISOString().slice(0, 19),
  });

  // Totales del día → medidas "kcal" y "proteina" del registro de hábitos y medidas (las lee push.py → garmin.db)
  function syncDayMetrics(date) {
    const day = Object.values(readJson(FLOG, {})).filter(e => e.date === date);
    const log = readJson(LOG_FILE, {}), ts = new Date().toISOString().slice(0, 19);
    for (const [key, nk] of [['kcal', 'kcal'], ['proteina', 'prot']]) {
      const id = `${date}|metric|${key}`;
      if (log[id] && log[id].src !== 'comida') continue;  // lo escrito a mano manda
      if (!day.length) { if (log[id]?.src === 'comida') delete log[id]; continue; }
      const v = Math.round(day.reduce((s, e) => s + (e.nut?.[nk] || 0), 0));
      log[id] = { date, kind: 'metric', key, value: v, ts, src: 'comida' };
    }
    writeAtomic(LOG_FILE, JSON.stringify(log));
  }

  // Open Food Facts: valores por 100 g en gramos → unidades de la app
  const OFF = { kcal: ['energy-kcal_100g', 1], prot: ['proteins_100g', 1], carb: ['carbohydrates_100g', 1], fat: ['fat_100g', 1],
    fib: ['fiber_100g', 1], sug: ['sugars_100g', 1], sat: ['saturated-fat_100g', 1], mono: ['monounsaturated-fat_100g', 1],
    poly: ['polyunsaturated-fat_100g', 1], o3: ['omega-3-fat_100g', 1], chol: ['cholesterol_100g', 1e3], na: ['sodium_100g', 1e3],
    k: ['potassium_100g', 1e3], ca: ['calcium_100g', 1e3], fe: ['iron_100g', 1e3], mg: ['magnesium_100g', 1e3], p: ['phosphorus_100g', 1e3],
    zn: ['zinc_100g', 1e3], cu: ['copper_100g', 1e3], mn: ['manganese_100g', 1e3], se: ['selenium_100g', 1e6], vita: ['vitamin-a_100g', 1e6],
    vitc: ['vitamin-c_100g', 1e3], vitd: ['vitamin-d_100g', 1e6], vite: ['vitamin-e_100g', 1e3], vitk: ['vitamin-k_100g', 1e6],
    b1: ['vitamin-b1_100g', 1e3], b2: ['vitamin-b2_100g', 1e3], b3: ['vitamin-pp_100g', 1e3], b5: ['pantothenic-acid_100g', 1e3],
    b6: ['vitamin-b6_100g', 1e3], fol: ['vitamin-b9_100g', 1e6], b12: ['vitamin-b12_100g', 1e6], caf: ['caffeine_100g', 1e3] };
  async function barcode(code) {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_es,brands,nutriments,serving_size,serving_quantity,quantity`,
      { headers: { 'User-Agent': 'MiGarmin/1.0 (uso personal)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status !== 1 || !d.product) return null;
    const p = d.product, m = p.nutriments || {}, nut = {};
    for (const [k, [f, mul]] of Object.entries(OFF)) if (m[f] != null && m[f] !== '') nut[k] = Math.round(Number(m[f]) * mul * 1e4) / 1e4;
    if (nut.kcal == null && m['energy_100g'] != null) nut.kcal = Math.round(Number(m['energy_100g']) / 4.184);
    if (nut.na == null && m['salt_100g'] != null) nut.na = Math.round(Number(m['salt_100g']) * 400);
    const pt = [{ n: 'g', f: 0.01 }], sq = Number(p.serving_quantity);
    if (sq > 0) pt.push({ n: `ración (${p.serving_size || sq + ' g'})`, f: Math.round(sq) / 100 });
    return { n: p.product_name_es || p.product_name || 'Producto ' + code, brand: (p.brands || '').split(',')[0].trim(), g: 'Mis alimentos',
      src: 'Open Food Facts ' + code, base: '100 g', nut, pt, code };
  }

  const mcpApp = require('./mcp')({ DATA_DIR, LOG_FILE, FLOG, FCUSTOM, FGOALS, DEFAULT_GOALS, MEALS, PUB, send, json, readBody, readJson, writeAtomic,
    cleanFood, cleanNut, syncDayMetrics, barcode });

  return async function handle(req, res, p, url, { session, bearer }) {
    if (await mcpApp(req, res, p, url) !== false) return;  // conector de Claude: tiene su propio login (OAuth)
    if (!(p === '/comida' || p.startsWith('/comida/') || p.startsWith('/api/food/'))) return false;
    if (p === '/api/food/export') {
      if (!bearer) return json(res, 401, { error: 'token' });
      return json(res, 200, { entries: Object.values(readJson(FLOG, {})), custom: Object.values(readJson(FCUSTOM, {})), goals: readJson(FGOALS, DEFAULT_GOALS) });
    }
    // Alimentos que Claude añade desde el Mac (comida/subir_nuevos.py, con el token de subida)
    if (bearer && p === '/api/food/custom' && req.method === 'GET') return json(res, 200, Object.values(readJson(FCUSTOM, {})));
    if (bearer && p === '/api/food/custom' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 262144)), list = Array.isArray(b) ? b : [b], all = readJson(FCUSTOM, {}), out = [];
      if (list.length > 50) return json(res, 400, { error: 'máximo 50 alimentos por envío' });
      for (const x of list) { const f = cleanFood(x); all[f.id] = f; out.push(f); }
      writeAtomic(FCUSTOM, JSON.stringify(all));
      return json(res, 200, out);
    }
    // El Mac también puede apuntar comidas y agua (comida/subir_nuevos.py, archivos registro-*.json)
    const macWrite = bearer && req.method === 'POST' && (p === '/api/food/log' || p === '/api/food/water');
    if (!session && !macWrite) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'login' });
      return send(res, 303, '', 'text/plain', { Location: '/login' });
    }
    if (p === '/comida' || p === '/comida/') return send(res, 200, fs.readFileSync(path.join(PUB, 'comida.html')), 'text/html; charset=utf-8');
    if (p === '/comida/foods.json') return send(res, 200, fs.readFileSync(path.join(PUB, 'foods.json')), 'application/json; charset=utf-8', { 'Cache-Control': 'no-cache' });

    if (p === '/api/food/log' && req.method === 'GET') {
      const from = DATE.test(url.searchParams.get('from')) ? url.searchParams.get('from') : new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
      const to = DATE.test(url.searchParams.get('to')) ? url.searchParams.get('to') : '9999';
      return json(res, 200, Object.values(readJson(FLOG, {})).filter(e => e.date >= from && e.date <= to));
    }
    if (p === '/api/food/log' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 65536));
      const list = Array.isArray(b) ? b.slice(0, 60) : [b], all = readJson(FLOG, {}), days = new Set(), out = [];
      for (const x of list) {
        if (!DATE.test(x.date) || !MEALS.includes(x.meal)) return json(res, 400, { error: 'registro' });
        const id = typeof x.id === "string" && /^[a-z0-9-]{6,40}$/.test(x.id) ? x.id : crypto.randomBytes(8).toString('hex');
        if (all[id]) days.add(all[id].date);
        all[id] = { id, date: x.date, meal: x.meal, fid: str(x.fid, 70), name: str(x.name, 80), brand: str(x.brand, 60),
          qty: num(x.qty, 0, 1e5) ?? 1, pn: str(x.pn, 40), f: num(x.f, 0, 1e4) ?? 1, nut: cleanNut(x.nut), ts: new Date().toISOString().slice(0, 19) };
        days.add(x.date); out.push(all[id]);
      }
      writeAtomic(FLOG, JSON.stringify(all));
      days.forEach(syncDayMetrics);
      return json(res, 200, out);
    }
    if (p === '/api/food/log' && req.method === 'DELETE') {
      const all = readJson(FLOG, {}), ids = (url.searchParams.get('id') || '').split(','), days = new Set();
      for (const id of ids) if (all[id]) { days.add(all[id].date); delete all[id]; }
      writeAtomic(FLOG, JSON.stringify(all));
      days.forEach(syncDayMetrics);
      return json(res, 200, { deleted: ids.length });
    }
    if (p === '/api/food/custom' && req.method === 'GET') return json(res, 200, Object.values(readJson(FCUSTOM, {})));
    if (p === '/api/food/custom' && req.method === 'POST') {
      const f = cleanFood(JSON.parse(await readBody(req, 65536))), all = readJson(FCUSTOM, {});
      all[f.id] = f; writeAtomic(FCUSTOM, JSON.stringify(all));
      return json(res, 200, f);
    }
    if (p === '/api/food/custom' && req.method === 'DELETE') {
      const all = readJson(FCUSTOM, {}); delete all[url.searchParams.get('id')];
      writeAtomic(FCUSTOM, JSON.stringify(all));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/food/goals' && req.method === 'GET') return json(res, 200, { ...DEFAULT_GOALS, ...readJson(FGOALS, {}) });
    if (p === '/api/food/goals' && req.method === 'PUT') {
      const b = JSON.parse(await readBody(req, 4096));
      const g = { mode: b.mode === 'fixed' ? 'fixed' : 'garmin', kcal: num(b.kcal, 800, 5000) ?? 1800, adjust: num(b.adjust, -1000, 1000) ?? 0,
        protein_gkg: num(b.protein_gkg, 0.8, 3) ?? 1.6, weight: num(b.weight, 30, 200) ?? 60, fat_pct: num(b.fat_pct, 15, 50) ?? 30, show_micros: b.show_micros !== false, water_l: num(b.water_l, 0.5, 6) ?? 2 };
      writeAtomic(FGOALS, JSON.stringify(g));
      return json(res, 200, g);
    }
    if (p === '/api/food/water' && req.method === 'GET') {
      const from = DATE.test(url.searchParams.get('from')) ? url.searchParams.get('from') : '0000', out = {};
      for (const e of Object.values(readJson(LOG_FILE, {}))) if (e.kind === 'metric' && e.key === 'agua' && e.date >= from) out[e.date] = e.value;
      return json(res, 200, out);
    }
    if (p === '/api/food/water' && req.method === 'POST') {
      // {date, add_ml} suma o resta un vaso; {date, min_l} deja al menos esos litros. Se lee y escribe de una vez.
      const b = JSON.parse(await readBody(req, 1024)), add = num(b.add_ml, -5000, 5000), min = num(b.min_l, 0, 10);
      if (!DATE.test(b.date) || (add == null && min == null)) return json(res, 400, { error: 'agua' });
      const log = readJson(LOG_FILE, {}), id = `${b.date}|metric|agua`, cur = log[id]?.value || 0;
      const v = Math.round(Math.min(10, Math.max(0, min != null ? Math.max(cur, min) : cur + add / 1000)) * 100) / 100;
      if (v === 0) delete log[id];
      else log[id] = { date: b.date, kind: 'metric', key: 'agua', value: v, ts: new Date().toISOString().slice(0, 19) };
      writeAtomic(LOG_FILE, JSON.stringify(log));
      return json(res, 200, { date: b.date, value: v });
    }
    if (p === '/api/food/barcode') {
      const code = url.searchParams.get('code') || '';
      if (!/^\d{6,14}$/.test(code)) return json(res, 400, { error: 'código' });
      const custom = Object.values(readJson(FCUSTOM, {})).find(f => f.code === code);
      if (custom) return json(res, 200, { ...custom, known: true });
      try { const f = await barcode(code); return f ? json(res, 200, f) : json(res, 404, { error: 'no encontrado' }); }
      catch (e) { return json(res, 502, { error: 'Open Food Facts no responde' }); }
    }
    return send(res, 404, 'No encontrado');
  };
};
