// Conector de Claude (servidor MCP remoto) para apuntar comidas hablando con Claude desde cualquier sitio, sin el Mac.
//   POST /comida/mcp                       → MCP (Streamable HTTP, JSON-RPC), con token OAuth
//   /.well-known/oauth-protected-resource  → dónde está el servidor de autorización (spec MCP 2025-06-18)
//   /.well-known/oauth-authorization-server → metadatos OAuth (spec MCP 2025-03-26)
//   /comida/oauth/register | authorize | token → registro dinámico, login con la contraseña de la app y tokens
// Se añade una vez en claude.ai → Ajustes → Conectores con la URL https://<app>/comida/mcp.
// Los tokens se guardan con hash en DATA_DIR/mcp_auth.json; solo se aceptan redirecciones a claude.ai / claude.com.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function mcp(ctx) {
  const { DATA_DIR, LOG_FILE, FLOG, FCUSTOM, FGOALS, DEFAULT_GOALS, MEALS, PUB, send, json, readBody, readJson, writeAtomic,
    cleanFood, cleanNut, syncDayMetrics, barcode } = ctx;
  const APP_PASSWORD = process.env.APP_PASSWORD || '';
  const AUTH = path.join(DATA_DIR, 'mcp_auth.json');   // { clients: {id: {...}}, tokens: {sha256: {kind, client, exp}} }
  const DATA_FILE = path.join(DATA_DIR, 'data.json');  // panel de Garmin que sube el Mac (gasto y peso)
  const DB = JSON.parse(fs.readFileSync(path.join(PUB, 'foods.json'), 'utf8'));
  const NUTS = DB.nutrients;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TOKEN_DAYS = 30, REFRESH_DAYS = 365;
  // la página de contraseña no se puede incrustar en otra web (X-Frame-Options ya lo pone send) ni cargar nada externo
  const CSP = { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" };
  const codes = new Map();            // código de un solo uso → {client, redirect, challenge, exp}
  const tries = [];                   // intentos de contraseña fallidos (límite global)
  const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
  const same = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
  const rnd = n => crypto.randomBytes(n).toString('base64url');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r1 = x => Math.round(x * 10) / 10, r0 = x => Math.round(x);

  // Origen público fijo (PUBLIC_URL o la app de Fly); solo en pruebas locales se usa el Host de la petición
  const PUBLIC = (process.env.PUBLIC_URL || 'https://mi-garmin-magda.fly.dev').replace(/\/$/, '');
  const base = req => { const host = String(req.headers.host || ''); return /^(localhost|127\.|\[::1\])/.test(host) ? `http://${host}` : PUBLIC; };
  const okRedirect = u => { try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)claude\.(ai|com)$/.test(x.hostname); } catch { return false; } };
  const authDb = () => { const a = readJson(AUTH, {}); a.clients ||= {}; a.tokens ||= {}; return a; };
  function issue(client) {
    const a = authDb(), now = Date.now(), access = rnd(32), refresh = rnd(32);
    for (const [k, t] of Object.entries(a.tokens)) if (t.exp < now) delete a.tokens[k];
    a.tokens[sha(access)] = { kind: 'access', client, exp: now + TOKEN_DAYS * 864e5 };
    a.tokens[sha(refresh)] = { kind: 'refresh', client, exp: now + REFRESH_DAYS * 864e5 };
    writeAtomic(AUTH, JSON.stringify(a));
    return { access_token: access, token_type: 'Bearer', expires_in: TOKEN_DAYS * 86400, refresh_token: refresh };
  }
  function tokenOk(req) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    const t = authDb().tokens[sha(m[1].trim())];
    return !!t && t.kind === 'access' && t.exp > Date.now();
  }

  // ---------- Fechas, alimentos y objetivos ----------
  const madrid = (d = new Date()) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) + Number(p.minute) / 60 };
  };
  const foods = () => { const out = {}; for (const f of DB.foods) out[f.id] = f; for (const f of Object.values(readJson(FCUSTOM, {}))) out[f.id] = f; return out; };
  const portions = f => (f.pt && f.pt.length ? f.pt : [{ n: f.base || 'ración', f: 1 }]);
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ');
  const mine = f => !String(f.id).startsWith('b-');   // sus productos (m-), recetas (r-) y creados (c-…); b- = básicos USDA
  function usage() {   // cuántas veces ha apuntado cada alimento en 90 días y con qué ración
    const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), u = {};
    for (const e of Object.values(readJson(FLOG, {}))) {
      if (!e.fid || !(e.date >= since)) continue;
      const x = u[e.fid] ||= { n: 0, last: '', por: {} }, k = `${e.qty} ${e.pn}`;
      x.n++; if (e.date > x.last) x.last = e.date; x.por[k] = (x.por[k] || 0) + 1;
    }
    return u;
  }
  const usedTxt = x => x && `${x.n} ${x.n === 1 ? 'vez' : 'veces'} en 90 días, última ${x.last}, suele ser ${Object.entries(x.por).sort((a, b) => b[1] - a[1])[0][0]}`;
  function search(q, db, limit = 8, use = {}) {
    const toks = norm(q).split(/\s+/).filter(t => t.length > 1), out = [];
    for (const f of Object.values(db)) {
      const name = norm(f.n), brand = norm(f.brand), group = norm(f.g), words = (name + ' ' + brand).split(/\s+/);
      let s = 0;
      for (const t of toks) {
        if (words.includes(t)) s += 3;
        else if (words.some(w => w.startsWith(t) || (t.length > 3 && w.startsWith(t.slice(0, -1))))) s += 2;
        else if ((name + ' ' + brand).includes(t)) s += 1;
        else if (group.includes(t)) s += 0.5;
      }
      if (s) out.push([s + (mine(f) ? 2 : 0) + Math.min(3, Math.log2(1 + (use[f.id]?.n || 0))), f]);
    }
    return out.sort((a, b) => b[0] - a[0] || a[1].n.length - b[1].n.length).slice(0, limit).map(x => x[1]);
  }
  const brief = (f, use) => ({ id: f.id, nombre: f.n, marca: f.brand || undefined, grupo: f.g, suyo: mine(f) || undefined, usado: use ? usedTxt(use[f.id]) : undefined,
    base: f.base || '100 g', por_base: { kcal: r0(f.nut.kcal || 0), prot: r1(f.nut.prot || 0), hc: r1(f.nut.carb || 0), grasa: r1(f.nut.fat || 0) },
    raciones: portions(f).map(p => `${p.n} = ${r0((f.nut.kcal || 0) * p.f)} kcal`) });
  function targets() {
    const g = { ...DEFAULT_GOALS, ...readJson(FGOALS, {}) }, days = (readJson(DATA_FILE, {}).days || []), today = madrid().date;
    const vals = days.filter(x => x.date < today && x.kcal_total > 800).slice(-7).map(x => x.kcal_total);
    let kcal = g.mode === 'garmin' && vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length + (g.adjust || 0) : g.kcal;
    kcal = Math.round(kcal / 10) * 10;
    const wd = days.slice().reverse().find(x => x.weight_7d || x.weight), w = wd ? wd.weight_7d || wd.weight : g.weight || 60;
    const prot = Math.round(w * g.protein_gkg), fat = Math.round(kcal * g.fat_pct / 100 / 9);
    return { kcal, prot, hc: Math.max(0, Math.round((kcal - prot * 4 - fat * 9) / 4)), grasa: fat, agua_l: g.water_l || 2,
      kcal_segun: g.mode === 'garmin' && vals.length ? `gasto medio de Garmin (${vals.length} días)${g.adjust ? ` ${g.adjust > 0 ? '+' : ''}${g.adjust}` : ''}` : 'fijo' };
  }
  const guessMeal = (f, h) => f.g === 'Suplementos' ? 'suplementos' : h < 11.5 ? 'desayuno' : h < 16.5 ? 'comida' : h < 19.5 ? 'merienda' : 'cena';
  const MEAL_ALIAS = { picoteo: 'snacks', snack: 'snacks', suplemento: 'suplementos', almuerzo: 'comida', postre: 'snacks' };
  function pickPortion(f, name) {
    const pts = portions(f);
    if (!name) return pts.find(p => p.n === 'g' || p.n === 'ml') || pts[0];
    const n = norm(name).trim();
    for (const test of [p => norm(p.n).trim() === n, p => norm(p.n).startsWith(n), p => norm(p.n).includes(n)]) { const hit = pts.find(test); if (hit) return hit; }
    if (['g', 'gramos', 'ml'].includes(n) && /^100 (g|ml)$/.test(f.base || '100 g')) return { n: (f.base || '').includes('ml') ? 'ml' : 'g', f: 0.01 };
    throw new Error(`"${f.n}" no tiene la ración "${name}". Raciones: ${pts.map(p => p.n).join(', ')}`);
  }
  function dayView(date) {
    const es = Object.values(readJson(FLOG, {})).filter(e => e.date === date), tot = {};
    for (const e of es) for (const [k, v] of Object.entries(e.nut || {})) tot[k] = (tot[k] || 0) + v;
    const t = targets(), water = readJson(LOG_FILE, {})[`${date}|metric|agua`]?.value || 0;
    const micros = NUTS.filter(n => n.t).map(n => ({ n: n.l, v: tot[n.k] || 0, u: n.u, pct: Math.round((tot[n.k] || 0) / n.t * 100) }));
    return {
      fecha: date,
      comidas: MEALS.map(m => ({ comida: m === 'snacks' ? 'picoteo' : m, entradas: es.filter(e => e.meal === m).map(e => ({ id: e.id, nombre: e.name, marca: e.brand || undefined,
        cantidad: `${e.qty} ${e.pn}`, kcal: r0(e.nut?.kcal || 0), prot: r1(e.nut?.prot || 0) })) })).filter(m => m.entradas.length),
      total: { kcal: r0(tot.kcal || 0), prot: r0(tot.prot || 0), hc: r0(tot.carb || 0), grasa: r0(tot.fat || 0), fibra: r1(tot.fib || 0) },
      objetivos: t, agua_l: water,
      micros_bajos: micros.filter(m => m.pct < 80).sort((a, b) => a.pct - b.pct).map(m => `${m.n} ${m.pct}% (${r1(m.v)} ${m.u})`),
      micros_ok: micros.filter(m => m.pct >= 80).length + ' de ' + micros.length + ' nutrientes al 80% o más',
    };
  }

  // ---------- Herramientas ----------
  const S = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
  const TOOLS = [
    { name: 'buscar_alimentos', description: 'Busca en la base de alimentos de Magdalena: sus productos guardados (suyo: true) y básicos genéricos USDA (ids "b-"). Salen primero los suyos y los que más apunta; "usado" dice cuántas veces y con qué ración suele apuntarlo. Usa siempre uno suyo si encaja con lo que dice; un genérico solo si no tiene ninguno parecido, y entonces díselo. Varias consultas a la vez.',
      inputSchema: S({ consultas: { type: 'array', items: { type: 'string' }, description: 'p. ej. ["leche lacturale", "pan oroweat"]' } }, ['consultas']) },
    { name: 'ver_dia', description: 'Lo apuntado un día (con los id de cada entrada), totales, objetivos de kcal y macros, agua y los micronutrientes más bajos.',
      inputSchema: S({ fecha: { type: 'string', description: 'AAAA-MM-DD; por defecto hoy (hora de Madrid)' } }) },
    { name: 'apuntar', description: 'Apunta alimentos en el diario. Cada entrada: fid (de buscar_alimentos), cantidad y racion (nombre de una ración del alimento, o "g"/"ml"; si se omite, gramos). comida: desayuno, comida, merienda, cena, picoteo o suplementos (si se omite, según la hora). Para corregir una entrada ya apuntada pasa su id.',
      inputSchema: S({ fecha: { type: 'string', description: 'AAAA-MM-DD; por defecto hoy' },
        entradas: { type: 'array', items: S({ fid: { type: 'string' }, cantidad: { type: 'number' }, racion: { type: 'string' }, comida: { type: 'string' }, id: { type: 'string', description: 'solo para sustituir una entrada existente' } }, ['fid', 'cantidad']) } }, ['entradas']) },
    { name: 'borrar_entradas', description: 'Borra entradas del diario por su id (los da ver_dia).',
      inputSchema: S({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']) },
    { name: 'crear_alimento', description: 'Crea o actualiza un alimento propio (aparece en Mis alimentos). Valores por la base indicada (normalmente 100 g o 100 ml). Claves de nut: kcal, prot, carb, fat, fib, sug, sat, mono, poly, o3 (g); chol, na, k, ca, fe, mg, p, zn, cu, mn, vitc, vite, b1, b2, b3, b5, b6, chl, caf (mg); se, vita, vitd, vitk, fol, b12 (µg). Omite las que no sepas. Sodio (mg) = sal (g) × 400. raciones: f = gramos de la ración / 100 si la base es 100 g. Mismo id = actualiza.',
      inputSchema: S({ id: { type: 'string', description: 'c- + minúsculas/números/guiones; omitir para uno nuevo' }, nombre: { type: 'string' }, marca: { type: 'string' },
        grupo: { type: 'string', description: 'por defecto "Mis alimentos"; "Recetas" para recetas' }, base: { type: 'string', description: '"100 g", "100 ml", "1 ración"…' },
        raciones: { type: 'array', items: S({ n: { type: 'string' }, f: { type: 'number' } }, ['n', 'f']) }, nut: { type: 'object', additionalProperties: { type: 'number' } },
        fuente: { type: 'string', description: 'de dónde salen los valores' }, codigo: { type: 'string' } }, ['nombre', 'nut']) },
    { name: 'buscar_codigo_barras', description: 'Busca un código de barras en Open Food Facts (o entre sus alimentos). No guarda nada: revisa los valores y usa crear_alimento.',
      inputSchema: S({ codigo: { type: 'string' } }, ['codigo']) },
    { name: 'mis_alimentos', description: 'Lista sus alimentos guardados (productos, recetas y creados), los más usados primero, con sus raciones y su ración habitual. Útil para elegir con precisión o para revisar duplicados.',
      inputSchema: S({ filtro: { type: 'string', description: 'texto opcional para filtrar por nombre, marca o grupo' } }) },
    { name: 'borrar_alimento', description: 'Borra alimentos creados por ella o por Claude (Mis alimentos y Recetas creadas) por su id. Lo ya apuntado en el diario no cambia. Los de la base fija (ids "b-", "m-", "r-") no se pueden borrar: crea uno corregido con crear_alimento.',
      inputSchema: S({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']) },
    { name: 'apuntar_agua', description: 'Suma (o resta, con negativo) agua bebida en ml a un día.',
      inputSchema: S({ ml: { type: 'number' }, fecha: { type: 'string' } }, ['ml']) },
  ];
  const train = require('../entreno_mcp')({ DATA_DIR, readJson, writeAtomic }); TOOLS.push(...train.TOOLS);  // entreno (mobile/entreno_mcp.js)
  const salud = require('../salud_mcp')({ DATA_DIR, LOG_FILE, FGOALS, DEFAULT_GOALS, readJson }); TOOLS.push(...salud.TOOLS);  // salud, solo lectura (mobile/salud_mcp.js)

  async function call(name, a) {
    if (train.has(name)) return train.call(name, a);
    if (salud.has(name)) return salud.call(name, a);
    const now = madrid(), date = a.fecha || now.date;
    if (a.fecha != null && !DATE.test(a.fecha)) throw new Error('fecha en formato AAAA-MM-DD');
    if (name === 'buscar_alimentos') {
      const db = foods();
      const use = usage();
      return Object.fromEntries((a.consultas || []).slice(0, 20).map(q => [q, search(q, db, 8, use).map(f => brief(f, use))]));
    }
    if (name === 'mis_alimentos') {
      const use = usage(), q = norm(a.filtro || '').trim();
      const list = Object.values(foods()).filter(f => mine(f) && (!q || norm(`${f.n} ${f.brand || ''} ${f.g || ''}`).includes(q)))
        .sort((x, y) => (use[y.id]?.n || 0) - (use[x.id]?.n || 0) || String(x.n).localeCompare(String(y.n), 'es'));
      return { total: list.length, alimentos: list.slice(0, 200).map(f => ({ id: f.id, nombre: f.n, marca: f.brand || undefined, grupo: f.g,
        kcal_base: `${r0(f.nut?.kcal || 0)} kcal / ${f.base || '100 g'}`, raciones: portions(f).map(p => p.n), usado: usedTxt(use[f.id]) })) };
    }
    if (name === 'borrar_alimento') {
      const all = readJson(FCUSTOM, {}), gone = [], no = [];
      for (const id of a.ids || []) if (all[id]) { gone.push(`${all[id].n}${all[id].brand ? ` (${all[id].brand})` : ''}`); delete all[id]; } else no.push(id);
      if (gone.length) writeAtomic(FCUSTOM, JSON.stringify(all));
      return { borrado: gone, no_borrado: no.length ? no.map(id => `${id}: ${foods()[id] ? 'es de la base fija, no se puede borrar' : 'no existe'}`) : undefined };
    }
    if (name === 'ver_dia') return dayView(date);
    if (name === 'apuntar') {
      const db = foods(), all = readJson(FLOG, {}), list = (a.entradas || []).slice(0, 40), days = new Set([date]), done = [];
      if (!list.length) throw new Error('no hay entradas');
      const built = list.map(it => {
        const f = db[it.fid];
        if (!f) throw new Error(`No existe el alimento "${it.fid}"; usa buscar_alimentos`);
        const p = pickPortion(f, it.racion), qty = Number(it.cantidad);
        if (!(qty > 0 && qty < 1e5)) throw new Error(`cantidad rara para ${f.n}`);
        let meal = String(it.comida || guessMeal(f, now.hour)).toLowerCase(); meal = MEAL_ALIAS[meal] || meal;
        if (!MEALS.includes(meal)) throw new Error(`comida "${it.comida}" no válida`);
        if (it.id != null && !/^[a-z0-9-]{6,40}$/.test(it.id)) throw new Error(`id no válido: ${it.id}`);
        const mul = p.f * qty, nut = {};
        for (const [k, v] of Object.entries(f.nut || {})) if (typeof v === 'number') nut[k] = v * mul;
        return { id: it.id || `m${date.replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`, date, meal, fid: f.id, name: String(f.n).slice(0, 80),
          brand: String(f.brand || '').slice(0, 60), qty: Math.round(qty * 1000) / 1000, pn: String(p.n).slice(0, 40), f: p.f, nut: cleanNut(nut), ts: new Date().toISOString().slice(0, 19) };
      });
      for (const e of built) { if (all[e.id]) days.add(all[e.id].date); all[e.id] = e; done.push(`${e.meal === 'snacks' ? 'picoteo' : e.meal}: ${e.name} · ${e.qty} ${e.pn} · ${r0(e.nut.kcal || 0)} kcal, ${r1(e.nut.prot || 0)} g prot [${e.id}]`); }
      writeAtomic(FLOG, JSON.stringify(all));
      days.forEach(syncDayMetrics);
      const v = dayView(date);
      const gen = built.filter(e => !mine(db[e.fid])).map(e => e.name);
      return { apuntado: done, genericos: gen.length ? `Sin producto suyo, se usó el genérico: ${gen.join(', ')}` : undefined, total_dia: v.total, objetivos: v.objetivos };
    }
    if (name === 'borrar_entradas') {
      const all = readJson(FLOG, {}), days = new Set(), gone = [];
      for (const id of a.ids || []) if (all[id]) { days.add(all[id].date); gone.push(`${all[id].name} (${all[id].date})`); delete all[id]; }
      writeAtomic(FLOG, JSON.stringify(all));
      days.forEach(syncDayMetrics);
      return { borrado: gone, total_dia: days.size === 1 ? dayView([...days][0]).total : undefined };
    }
    if (name === 'crear_alimento') {
      const b100 = /^100 (g|ml)$/.test(a.base || '100 g'), unit = (a.base || '').includes('ml') ? 'ml' : 'g', pt = (a.raciones || []).filter(x => x && x.n);
      if (b100 && !pt.some(x => x.n === unit)) pt.unshift({ n: unit, f: 0.01 });  // siempre se puede apuntar en gramos o ml
      const f = cleanFood({ id: a.id, n: a.nombre, brand: a.marca, g: a.grupo, base: a.base || '100 g', nut: a.nut, src: a.fuente || 'creado por Claude', code: a.codigo,
        pt: pt.length ? pt : [{ n: a.base || 'ración', f: 1 }] });
      const all = readJson(FCUSTOM, {}), isNew = !all[f.id] && !a.id;
      const like = isNew ? search(`${a.nombre} ${a.marca || ''}`, foods(), 4).filter(x => mine(x) && x.id !== f.id) : [];
      all[f.id] = f; writeAtomic(FCUSTOM, JSON.stringify(all));
      return { guardado: brief(f), ya_tenia_parecidos: like.length ? like.map(x => `${x.id}: ${x.n}${x.brand ? ` (${x.brand})` : ''}`) : undefined,
        nota: like.length ? 'Si era uno de estos, borra el nuevo con borrar_alimento y usa el que ya tenía.' : undefined };
    }
    if (name === 'buscar_codigo_barras') {
      const code = String(a.codigo || '').trim();
      if (!/^\d{6,14}$/.test(code)) throw new Error('código no válido');
      const mine = Object.values(readJson(FCUSTOM, {})).find(f => f.code === code);
      if (mine) return { ya_guardado: brief(mine) };
      const f = await barcode(code).catch(() => { throw new Error('Open Food Facts no responde'); });
      return f ? { open_food_facts: f, nota: 'Los micronutrientes que falten (o salgan a 0) suelen ser datos no declarados, no ceros reales.' } : { no_encontrado: code };
    }
    if (name === 'apuntar_agua') {
      const add = Number(a.ml);
      if (!Number.isFinite(add) || Math.abs(add) > 5000) throw new Error('ml no válidos');
      const log = readJson(LOG_FILE, {}), id = `${date}|metric|agua`, cur = log[id]?.value || 0;
      const v = Math.round(Math.min(10, Math.max(0, cur + add / 1000)) * 100) / 100;
      if (v === 0) delete log[id]; else log[id] = { date, kind: 'metric', key: 'agua', value: v, ts: new Date().toISOString().slice(0, 19) };
      writeAtomic(LOG_FILE, JSON.stringify(log));
      return { fecha: date, agua_l: v, objetivo_l: targets().agua_l };
    }
    throw new Error('herramienta desconocida');
  }

  // ---------- MCP (JSON-RPC sobre HTTP) ----------
  const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
  const INSTRUCTIONS = 'Diario de comidas de Magdalena (app Mi Garmin, pestaña Comida). Tiene casi todo lo que come ya guardado: sé preciso. ' +
    'Para apuntar: buscar_alimentos con cada cosa → elige SIEMPRE su producto guardado (suyo: true) si encaja con lo que dice, mejor el que más usa; ' +
    'si dos suyos encajan igual y cambian mucho las calorías, pregúntale cuál; usa un genérico "b-" solo si no tiene ninguno parecido y díselo. ' +
    'Si no dice cantidad, usa su ración habitual ("usado"); si no hay, una razonable (vaso 250 ml, huevo 50 g, rebanada, cucharada de aceite 10 ml). ' +
    'Luego apuntar → resume en 2-4 líneas lo apuntado (con las cantidades supuestas) y el total del día. ' +
    'Para corregir o quitar algo: ver_dia da los id; apuntar con el mismo id cambia la cantidad, borrar_entradas lo quita del diario y borrar_alimento borra un alimento creado. ' +
    'Antes de crear un alimento mira si ya lo tiene (mis_alimentos). Responde en español.';
  async function rpc(m) {
    const reply = result => ({ jsonrpc: '2.0', id: m.id, result }), fail = (code, message) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return fail(-32600, 'petición no válida');
    if (m.id === undefined) return null;  // notificaciones (initialized, cancelled…)
    if (m.method === 'initialize') {
      const want = m.params?.protocolVersion;
      return reply({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: {} },
        serverInfo: { name: 'mi-garmin-comida', title: 'Mi Garmin · Comida', version: '1.0.0' },
        instructions: INSTRUCTIONS });
    }
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') return reply({ tools: TOOLS });
    if (m.method === 'tools/call') {
      const t = TOOLS.find(x => x.name === m.params?.name);
      if (!t) return fail(-32602, 'herramienta desconocida');
      try { const out = await call(t.name, m.params.arguments || {}); return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] }); }
      catch (e) { return reply({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
    }
    if (m.method === 'resources/list') return reply({ resources: [] });
    if (m.method === 'prompts/list') return reply({ prompts: [] });
    return fail(-32601, 'método no soportado');
  }

  // ---------- OAuth ----------
  const page = (body, code = 200) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mi Garmin · Conectar con Claude</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;background:#f4f3ef;color:#1c1f23;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;padding:28px 24px;border-radius:16px;max-width:340px;width:calc(100% - 32px);box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 8px}
p{color:#676d75;margin:0 0 18px;line-height:1.4}input{width:100%;box-sizing:border-box;font-size:17px;padding:12px;border:1px solid #d9d6cf;border-radius:10px;margin-bottom:12px}
button{width:100%;font-size:17px;padding:12px;border:0;border-radius:10px;background:#1f8a4c;color:#fff;font-weight:600}.err{color:#b3261e}
@media (prefers-color-scheme:dark){body{background:#121417;color:#ecebe7}main{background:#1b1e22}input{background:#121417;color:#ecebe7;border-color:#2b2f35}}</style></head><body><main>${body}</main></body></html>`;

  async function oauth(req, res, p, url) {
    try { return await oauthRoutes(req, res, p, url); }
    catch (e) { return json(res, 400, { error: 'invalid_request', error_description: e instanceof SyntaxError ? 'JSON no válido' : 'petición no válida' }); }
  }
  async function oauthRoutes(req, res, p, url) {
    const B = base(req);
    if (p === '/comida/oauth/register' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 8192)) || '{}'), uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 5) : [];
      if (!uris.length || !uris.every(okRedirect)) return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'solo claude.ai / claude.com' });
      const a = authDb(), id = 'mcp-' + rnd(12);
      if (Object.keys(a.clients).length > 50) { const old = Object.entries(a.clients).sort((x, y) => x[1].created - y[1].created)[0]; delete a.clients[old[0]]; }
      a.clients[id] = { redirect_uris: uris, name: String(b.client_name || 'Claude').slice(0, 60), created: Date.now() };
      writeAtomic(AUTH, JSON.stringify(a));
      return json(res, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris, client_name: a.clients[id].name,
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    }
    if (p === '/comida/oauth/authorize') {
      const q = req.method === 'POST' ? new URLSearchParams(await readBody(req, 8192)) : url.searchParams;
      const P = k => q.get(k) || '', client = authDb().clients[P('client_id')], redirect = P('redirect_uri');
      if (!client || !client.redirect_uris.includes(redirect) || !okRedirect(redirect)) return send(res, 400, page('<h1>Enlace no válido</h1><p>Vuelve a añadir el conector desde Claude.</p>'), 'text/html; charset=utf-8', CSP);
      if (P('response_type') !== 'code' || P('code_challenge_method') !== 'S256' || !P('code_challenge')) {
        const r = new URL(redirect); r.searchParams.set('error', 'invalid_request'); if (P('state')) r.searchParams.set('state', P('state'));
        return send(res, 302, '', 'text/plain', { Location: r.toString() });
      }
      const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'scope', 'resource'].map(k => `<input type="hidden" name="${k}" value="${esc(P(k))}">`).join('');
      const form = err => page(`<h1>Conectar Claude con Mi Garmin</h1><p>Claude podrá buscar tus alimentos, ver tu diario y apuntar comidas. Escribe la contraseña de tu app para permitirlo.</p>
${err ? `<p class="err">${err}</p>` : ''}<form method="post">${hidden}<input type="password" name="password" autocomplete="current-password" placeholder="Contraseña" required autofocus><button>Permitir</button></form>`);
      if (req.method !== 'POST') return send(res, 200, form(''), 'text/html; charset=utf-8', CSP);
      const now = Date.now(); while (tries.length && tries[0] < now - 15 * 6e4) tries.shift();
      if (tries.length >= 10) return send(res, 429, form('Demasiados intentos. Prueba dentro de 15 minutos.'), 'text/html; charset=utf-8', CSP);
      if (!APP_PASSWORD || !same(P('password'), APP_PASSWORD)) { tries.push(now); return send(res, 401, form('Contraseña incorrecta.'), 'text/html; charset=utf-8', CSP); }
      const code = rnd(24);
      for (const [k, c] of codes) if (c.exp < now) codes.delete(k);
      codes.set(code, { client: P('client_id'), redirect, challenge: P('code_challenge'), exp: now + 5 * 6e4 });
      const r = new URL(redirect); r.searchParams.set('code', code); if (P('state')) r.searchParams.set('state', P('state'));
      return send(res, 302, '', 'text/plain', { Location: r.toString() });
    }
    if (p === '/comida/oauth/token' && req.method === 'POST') {
      const raw = await readBody(req, 8192), ct = req.headers['content-type'] || '';
      const q = ct.includes('json') ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}'))) : new URLSearchParams(raw), P = k => q.get(k) || '';
      if (P('grant_type') === 'authorization_code') {
        const c = codes.get(P('code')); codes.delete(P('code'));
        const pk = crypto.createHash('sha256').update(P('code_verifier')).digest('base64url');
        if (!c || c.exp < Date.now() || c.client !== P('client_id') || c.redirect !== P('redirect_uri') || pk !== c.challenge) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue(c.client));
      }
      if (P('grant_type') === 'refresh_token') {
        const a = authDb(), h = sha(P('refresh_token')), t = a.tokens[h];
        if (!t || t.kind !== 'refresh' || t.exp < Date.now() || (P('client_id') && P('client_id') !== t.client)) return json(res, 400, { error: 'invalid_grant' });
        delete a.tokens[h]; writeAtomic(AUTH, JSON.stringify(a));  // el refresh se usa una vez
        return json(res, 200, issue(t.client));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/.well-known/oauth-authorization-server' || p.startsWith('/.well-known/oauth-authorization-server/') || p === '/.well-known/openid-configuration')
      return json(res, 200, { issuer: B, authorization_endpoint: `${B}/comida/oauth/authorize`, token_endpoint: `${B}/comida/oauth/token`, registration_endpoint: `${B}/comida/oauth/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['comida'] });
    if (p === '/.well-known/oauth-protected-resource' || p.startsWith('/.well-known/oauth-protected-resource/'))
      return json(res, 200, { resource: `${B}/comida/mcp`, authorization_servers: [B], scopes_supported: ['comida'], bearer_methods_supported: ['header'], resource_name: 'Mi Garmin · Comida' });
    return send(res, 404, 'No encontrado');
  }

  return async function handle(req, res, p, url) {
    if (p.startsWith('/.well-known/oauth-') || p === '/.well-known/openid-configuration' || p.startsWith('/comida/oauth/')) return oauth(req, res, p, url);
    if (p !== '/comida/mcp') return false;
    if (!tokenOk(req)) {
      return send(res, 401, JSON.stringify({ error: 'invalid_token' }), 'application/json; charset=utf-8',
        { 'WWW-Authenticate': `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource/comida/mcp"` });
    }
    if (req.method === 'GET') return send(res, 405, '', 'text/plain', { Allow: 'POST' });  // sin canal SSE: todo va en la respuesta
    if (req.method === 'DELETE') return send(res, 204, '');
    if (req.method !== 'POST') return send(res, 405, '', 'text/plain', { Allow: 'POST' });
    let body;
    try { body = JSON.parse(await readBody(req, 262144)); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON no válido' } }); }
    const out = Array.isArray(body) ? (await Promise.all(body.map(rpc))).filter(Boolean) : await rpc(body);
    if (!out || (Array.isArray(out) && !out.length)) return send(res, 202, '');
    return json(res, 200, out);
  };
};
