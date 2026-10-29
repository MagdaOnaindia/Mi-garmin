// Entreno de la app v2: valoración de cada sesión (RPE, qué fue, molestias, pesos), sesiones a mano,
// regla de progresión, ejercicios de cada entrenamiento y objetivos semanales.
//   GET  /api/train              → todo { sessions: {id: {...}}, settings: {...} } (requiere sesión)
//   POST /api/train/session      → guarda o cambia la valoración de una sesión {id, date?, kind?, rpe?, ...}; {id, delete:true} la borra
//   PUT  /api/train/settings     → { rule, plans, goals }
//   GET  /api/train/export       → el Mac lo descarga todo (Authorization: Bearer UPLOAD_TOKEN)
'use strict';
const path = require('path');

// Reglas compartidas con el conector de Claude (entreno_mcp.js): misma validación en la app y en Claude
const DATE = /^\d{4}-\d{2}-\d{2}$/, ID = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS = ['Funcional', 'Push', 'Pull', 'Legs', 'Movilidad', 'Fuerza', 'Bici', 'Cinta', 'Caminar', 'Pádel', 'Correr', 'Natación', 'Otro'];  // los nuevos van al final
const str = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);
const num = (v, lo, hi) => { if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null; };
// Músculos de «Mis ejercicios» (las mismas claves que la app)
const MUSCLES = ['pecho', 'hombros', 'biceps', 'triceps', 'antebrazo', 'abdomen', 'oblicuos', 'trapecio', 'dorsales', 'lumbar', 'gluteos', 'abductores', 'aductores', 'cuadriceps', 'isquios', 'gemelos', 'tibial', 'psoas'];
const muscles = a => [...new Set((Array.isArray(a) ? a : []).filter(m => MUSCLES.includes(m)))].slice(0, 10);
const cleanSets = a => a.slice(0, 20).map(x => ({ ex: str(x.ex, 60), series: num(x.series, 1, 10), reps: num(x.reps, 1, 100), kg: num(x.kg, 0, 500), ...(x.key ? { key: true } : {}) })).filter(x => x.ex);  // key: serie clave
// Valoración de una sesión: b son los cambios, prev lo guardado; los campos que no vienen se conservan
function sessionFrom(id, b, prev = {}) {
  return {
    id,
    date: DATE.test(b.date) ? b.date : prev.date || null,
    manual: b.manual != null ? !!b.manual : !!prev.manual,
    kind: KINDS.includes(b.kind) ? b.kind : prev.kind || null,
    name: b.name !== undefined ? str(b.name, 40).trim() : prev.name || '',   // para «Otro»: qué fue (yoga, baile…)
    rpe: b.rpe !== undefined ? num(b.rpe, 1, 10) : prev.rpe ?? null,
    minutes: b.minutes !== undefined ? num(b.minutes, 1, 600) : prev.minutes ?? null,
    strength: b.strength !== undefined ? (b.strength == null ? null : !!b.strength) : prev.strength ?? null,
    pain: b.pain !== undefined ? str(b.pain, 200) : prev.pain || '',
    note: b.note !== undefined ? str(b.note, 300) : prev.note || '',
    sets: Array.isArray(b.sets) ? cleanSets(b.sets) : prev.sets || [],
    // repasada en «¿Qué tal…?»: lo apuntado manda y el mapa ya no añade lo del reloj
    ...((b.reviewed !== undefined ? !!b.reviewed : !!prev.reviewed) ? { reviewed: true } : {}),
    ts: new Date().toISOString().slice(0, 19),
  };
}
function settingsFrom(b, cur = {}) {
  const rule = b.rule ? { top: num(b.rule.top, 3, 30) ?? 12, inc: num(b.rule.inc, 0.5, 20) ?? 2 } : cur.rule;
  const plans = b.plans && typeof b.plans === 'object' ? Object.fromEntries(Object.entries(b.plans).slice(0, 10)
    .filter(([k]) => KINDS.includes(k)).map(([k, v]) => [k, (Array.isArray(v) ? v : []).slice(0, 15).map(x => str(x, 60)).filter(Boolean)])) : cur.plans;
  const g = b.goals || {};
  const goals = b.goals ? { sleep_h: num(g.sleep_h, 5, 10) ?? 7, steps: num(g.steps, 1000, 30000) ?? 8000, im: num(g.im, 30, 600) ?? 150, strength: num(g.strength, 0, 7) ?? 2, bedtime: /^\d{2}:\d{2}$/.test(g.bedtime) ? g.bedtime : '23:30', z2_goal_min: num(g.z2_goal_min, 30, 600) ?? 90, move_goal_min: num(g.move_goal_min, 10, 300) ?? 45 } : cur.goals;  // z2: minutos de zona 2 a la semana
  // nombre que le das a cada ejercicio de tus entrenamientos de Connect (clave del ejercicio → tu nombre)
  const exmap = b.exmap && typeof b.exmap === 'object' ? Object.fromEntries(Object.entries(b.exmap).slice(0, 300)
    .map(([k, v]) => [str(k, 120).trim(), str(v, 60).trim()]).filter(([k, v]) => k && v)) : cur.exmap;
  // nutrientes que salen arriba en Comida → Nutrientes (claves de foods.json)
  const nut_top = Array.isArray(b.nut_top) ? b.nut_top.map(x => str(x, 8)).filter(x => /^[a-z0-9]{1,8}$/.test(x)).slice(0, 8) : cur.nut_top;
  // avisos al móvil: { clave: { on, at } } (las claves y horas por defecto están en server.js, NOTIFY_DEF)
  const notify = b.notify && typeof b.notify === 'object' ? Object.fromEntries(Object.entries(b.notify).slice(0, 12)
    .filter(([k, v]) => /^[a-z]{2,12}$/.test(k) && v && typeof v === 'object')
    .map(([k, v]) => [k, { on: !!v.on, ...(/^\d{2}:\d{2}$/.test(v.at) ? { at: v.at } : {}) }])) : cur.notify;
  // «Mis ejercicios»: nombre → { desc, main, sec, alias } (alias: otros nombres con los que llega del reloj); { hide: true } quita uno de partida
  const exercises = b.exercises && typeof b.exercises === 'object' ? Object.fromEntries(Object.entries(b.exercises).slice(0, 300)
    .map(([k, v]) => [str(k, 60).trim(), !v || typeof v !== 'object' ? null : v.hide ? { hide: true }
      : { desc: str(v.desc, 200).trim(), main: muscles(v.main), sec: muscles(v.sec), alias: (Array.isArray(v.alias) ? v.alias : []).map(a => str(a, 60).trim()).filter(Boolean).slice(0, 12) }])
    .filter(([k, v]) => k && v)) : cur.exercises;
  return { rule, plans, goals, ...(exmap ? { exmap } : {}), ...(exercises ? { exercises } : {}), ...(nut_top ? { nut_top } : {}), ...(notify ? { notify } : {}) };
}

module.exports = function entreno({ DATA_DIR, json, readBody, readJson, writeAtomic }) {
  const FILE = path.join(DATA_DIR, 'train.json');
  const load = () => { const d = readJson(FILE, {}); return { sessions: d.sessions || {}, settings: d.settings || {} }; };

  return async function (req, res, p, url, { session, bearer }) {
    if (!(p === '/api/train' || p.startsWith('/api/train/'))) return false;
    if (p === '/api/train/export') {
      if (!bearer) return json(res, 401, { error: 'token' });
      return json(res, 200, load());
    }
    if (!session) return json(res, 401, { error: 'login' });

    if (p === '/api/train' && req.method === 'GET') return json(res, 200, load());

    if (p === '/api/train/session' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 32768)), all = load();
      if (!ID.test(String(b.id))) return json(res, 400, { error: 'id' });
      const id = String(b.id);
      if (b.delete) { delete all.sessions[id]; writeAtomic(FILE, JSON.stringify(all)); return json(res, 200, { deleted: id }); }
      const s = sessionFrom(id, b, all.sessions[id]);
      all.sessions[id] = s;
      writeAtomic(FILE, JSON.stringify(all));
      return json(res, 200, s);
    }

    if (p === '/api/train/settings' && req.method === 'PUT') {
      const b = JSON.parse(await readBody(req, 32768)), all = load();
      all.settings = settingsFrom(b, all.settings);
      writeAtomic(FILE, JSON.stringify(all));
      return json(res, 200, all.settings);
    }
    return json(res, 404, { error: 'ruta' });
  };
};
module.exports.rules = { DATE, ID, KINDS, MUSCLES, sessionFrom, settingsFrom };
