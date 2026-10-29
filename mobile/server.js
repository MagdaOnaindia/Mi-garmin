// Mi Garmin (móvil): sirve el panel como app de pantalla de inicio, protegido con contraseña.
// Sin dependencias: solo Node. Los datos viven en el volumen /data.
//   GET  /                → panel (requiere sesión)
//   GET  /api/data        → datos del panel (requiere sesión)
//   GET/POST /api/mood    → registros de ánimo hechos en la app (requiere sesión)
//   POST /api/upload      → el Mac sube dashboard/data.js        (Authorization: Bearer UPLOAD_TOKEN)
//   GET  /api/mood/export → el Mac descarga los ánimos registrados (Authorization: Bearer UPLOAD_TOKEN)
//   GET/POST /api/log     → hábitos y medidas del día hechos en la app (requiere sesión)
//   GET/PUT  /api/config  → qué hábitos y medidas aparecen en la app (requiere sesión)
//   GET  /api/log/export  → el Mac descarga todos los registros (Authorization: Bearer UPLOAD_TOKEN)
//   /comida y /api/food/* → app de comida y micronutrientes (comida/comida.js)
//   GET  /api/push/key, POST /api/push/subscribe|unsubscribe|test → avisos en el iPhone (requiere sesión)
//   POST /api/sync/request, GET /api/sync/status → sincronizar con Garmin ahora (requiere sesión)
//   GET  /api/sync/pending, POST /api/sync/done → el Mac (sync_poll.py) mira si hay petición y avisa al acabar (token)
//   Con CLOUD_SYNC=1 sincroniza el propio servidor (sync/cloud_sync.py) cada 30 min y al pedirlo, y el Mac ya no:
//   GET /api/cloud/status, POST /api/cloud/run, GET /api/cloud/db|datajs, POST /api/cloud/seed?file= (token)
// Cada día a las REMIND_AT (hora de Madrid) avisa de rellenar el registro si ese día aún no hay nada apuntado.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUB = path.join(__dirname, 'public');
const { APP_PASSWORD, SESSION_SECRET, UPLOAD_TOKEN } = process.env;
if (!APP_PASSWORD || !SESSION_SECRET || !UPLOAD_TOKEN) {
  console.error('Faltan los secretos APP_PASSWORD, SESSION_SECRET o UPLOAD_TOKEN');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const MOOD_FILE = path.join(DATA_DIR, 'mood.json');
const LOG_FILE = path.join(DATA_DIR, 'log.json');        // { "2026-10-07|habit|alcohol": {date, kind, key, value, ts} }
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');    // claves de los avisos, se crean solas la primera vez
const PUSH_FILE = path.join(DATA_DIR, 'push.json');      // { subs: [...], lastReminder: "2026-10-07" }
const SYNC_FILE = path.join(DATA_DIR, 'sync_request.json'); // { requested, started, done, ok, error }
const CLOUD = process.env.CLOUD_SYNC === '1';                // sincroniza el servidor, no el Mac
const GARMIN_DIR = path.join(DATA_DIR, 'garmin');             // data/ del proyecto en el servidor: garmin.db, data.js...
const CLOUD_SCRIPT = process.env.CLOUD_SYNC_SCRIPT || '/app/garmin/sync/cloud_sync.py';
const CLOUD_EVERY = 30 * 60e3;    // sincronización automática cada 30 min
const SYNC_GAP = (CLOUD ? 5 : 10) * 60e3;  // como mucho una petición cada 5-10 min (Garmin corta con 429 si se le pide mucho)
const SYNC_MAX_AGE = 6 * 3600e3;  // una petición que el Mac no recoge en 6 h se descarta
const REMIND_AT = process.env.REMIND_AT || '22:00';
const TZ = 'Europe/Madrid';
const DEFAULT_CONFIG = {
  habits: [
    { key: 'alcohol', label: 'Alcohol' },
    { key: 'cafe_tarde', label: 'Café después de las 15 h' },
    { key: 'pantallas_noche', label: 'Pantallas en la cama' },
    { key: 'cena_tarde', label: 'Cena tarde (menos de 2 h antes de dormir)' },
    { key: 'movilidad', label: 'Estiramientos o movilidad' },
    { key: 'aire_libre', label: 'Al aire libre más de 30 min' },
    { key: 'estres_alto', label: 'Día de mucho estrés' },
    { key: 'creatina', label: 'Creatina' },
    { key: 'leer_noche', label: 'Leer un poco antes de dormir' },
  ],
  metrics: [
    { key: 'peso', label: 'Peso', unit: 'kg', step: 0.1 },
    { key: 'proteina', label: 'Proteína', unit: 'g', step: 1 },
    { key: 'kcal', label: 'Calorías comidas', unit: 'kcal', step: 10 },
    { key: 'agua', label: 'Agua', unit: 'L', step: 0.25 },
    { key: 'dolor', label: 'Dolor (psoas, lumbar, regla...)', unit: '0-10', step: 1 },
  ],
};
const KEY_RE = /^[a-z0-9_]{1,40}$/;
const COOKIE = 'mg_session';
const SESSION_DAYS = 365;

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

function sessionOk(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!exp && !!sig && same(sig, sign(exp)) && Number(exp) > Date.now();
}
const bearerOk = req => same((req.headers.authorization || '').replace(/^Bearer /, ''), UPLOAD_TOKEN);

const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow', 'Strict-Transport-Security': 'max-age=31536000',
};
function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { ...SEC, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req, limit) {
  return new Promise((ok, ko) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { ko(new Error('demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', ko);
  });
}
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } };
const foodApp = require('./comida/comida')({ DATA_DIR, LOG_FILE, send, json, readBody, readJson, writeAtomic });  // pestaña Comida
const trainApp = require('./entreno')({ DATA_DIR, json, readBody, readJson, writeAtomic });  // valoración de sesiones y progresión (app v2)

// Límite de intentos de contraseña: 10 cada 15 minutos por IP
const tries = new Map();
function tooMany(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 15 * 60e3);
  tries.set(ip, t);
  return t.length >= 10;
}

// Avisos (Web Push con cifrado aes128gcm y VAPID, solo con crypto de Node)
const b64u = b => Buffer.from(b).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
let VAPID = readJson(VAPID_FILE, null);
if (!VAPID) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  VAPID = { jwk: privateKey.export({ format: 'jwk' }) };
  writeAtomic(VAPID_FILE, JSON.stringify(VAPID));
}
const vapidKey = crypto.createPrivateKey({ key: VAPID.jwk, format: 'jwk' });
const vapidPub = Buffer.concat([Buffer.from([4]), Buffer.from(VAPID.jwk.x, 'base64url'), Buffer.from(VAPID.jwk.y, 'base64url')]);

function encrypt(sub, payload) {
  const uaPub = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), shared = ecdh.computeSecret(uaPub);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const salt = crypto.randomBytes(16), prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}
function vapidAuth(endpoint) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: 'https://mi-garmin-magda.fly.dev' }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: vapidKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${b64u(vapidPub)}`;
}
async function pushAll(msg) {
  const st = readJson(PUSH_FILE, { subs: [] }), keep = [];
  let sent = 0;
  for (const sub of st.subs) {
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', body: encrypt(sub, JSON.stringify(msg)), headers: {
        Authorization: vapidAuth(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' } });
      if (r.status === 404 || r.status === 410) continue;      // el iPhone ya no acepta esta suscripción
      if (r.ok) sent++; else console.error('aviso', r.status, await r.text());
    } catch (e) { console.error('aviso', e.message); }
    keep.push(sub);
  }
  writeAtomic(PUSH_FILE, JSON.stringify({ ...readJson(PUSH_FILE, {}), subs: keep }));
  return { sent, subs: keep.length };
}
const madridNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const loggedOn = date => readJson(MOOD_FILE, []).some(m => m.ts.startsWith(date)) || Object.values(readJson(LOG_FILE, {})).some(e => e.date === date);
// ---------- Avisos al móvil (Objetivos → Avisos en la app; preferencias en train.json settings.notify) ----------
// Como mucho 2 al día (el de salud va aparte), nunca antes de las 8:00 ni después de las 23:00 (Madrid).
// Si coinciden varios, sale primero el de más arriba en NOTIFY_ORDER. Estado del día en /data/avisos.json.
const NOTIFY_DEF = { salud: { on: true }, registro: { on: true, at: REMIND_AT }, cama: { on: false, at: '23:00' }, pasos: { on: true, at: '18:30' },
  agua: { on: true, at: '17:00' }, semana: { on: true, at: '19:00' }, peso: { on: true, at: '09:00' }, valorar: { on: true, at: '08:00' } };
const NOTIFY_ORDER = ['cama', 'valorar', 'registro', 'pasos', 'agua', 'peso', 'semana'];
// «Apunta cómo ha ido»: una sesión de fuerza/funcional de hoy sin RPE, unos 20 min después de que acabe; una vez por sesión
const AFTER_CAT = ['Fuerza', 'HIIT', 'Movilidad'];
// diferencia de la hora de Madrid con UTC en ese momento (cambia con el horario de verano)
const madridOffset = ms => { const d = new Date(ms); return Date.parse(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }) + ' UTC') - Date.parse(d.toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC'); };
function pendingRating(date, st) {
  const T = (readJson(TRAIN_FILE, {}) || {}).sessions || {}, now = Date.now(), done = st.valorados || [];
  for (const a of (readJson(DATA_FILE, {}).activities || []).filter(x => x.date === date && AFTER_CAT.includes(x.category)).reverse()) {
    const s = T[String(a.id)] || {}, iso = String(a.start_local || '').replace(' ', 'T'), t0 = Date.parse(iso + 'Z'), end = t0 - madridOffset(t0) + (a.duration_s || 0) * 1000;
    if (s.rpe != null || done.includes(String(a.id)) || !Number.isFinite(end) || now - end < 20 * 6e4) continue;
    const name = s.kind || (/legs|pierna/i.test(a.name) ? 'Legs' : /push/i.test(a.name) ? 'Push' : /pull/i.test(a.name) ? 'Pull' : a.category === 'HIIT' ? 'el funcional' : a.name || 'tu sesión');
    return { id: String(a.id), msg: { title: 'Apunta cómo ha ido', body: `Apunta cómo ha ido ${name}: un toque para el esfuerzo y, si quieres, los pesos.`, url: '/#valorar' } };
  }
  return null;
}
const NOTIFY_FILE = path.join(DATA_DIR, 'avisos.json'), TRAIN_FILE = path.join(DATA_DIR, 'train.json');
const trainSettings = () => (readJson(TRAIN_FILE, {}) || {}).settings || {};
const notifyPrefs = () => { const n = trainSettings().notify || {}; return Object.fromEntries(Object.entries(NOTIFY_DEF).map(([k, d]) => [k, { ...d, ...(n[k] || {}) }])); };
const fmtN = n => Math.round(n).toLocaleString('es-ES');
// Cada aviso: devuelve el mensaje si toca mandarlo ahora, o null (y ya no se vuelve a mirar ese día)
const NOTIFY_CHECK = {
  registro: date => loggedOn(date) ? null : { title: 'Mi Garmin', body: 'Rellena el registro de hoy: ánimo, hábitos y medidas.', url: '/#registro' },
  cama: () => ({ title: 'Hora de ir preparándote para dormir', body: `Tu objetivo es acostarte a las ${(trainSettings().goals || {}).bedtime || '23:30'}.`, url: '/' }),
  pasos: date => { const d = (readJson(DATA_FILE, {}).days || []).find(x => x.date === date), g = (trainSettings().goals || {}).steps || readJson(DATA_FILE, {}).step_goal || 10000;
    if (!d || d.steps == null || d.steps >= g * 0.6) return null;
    return { title: 'Te faltan pasos', body: `Llevas ${fmtN(d.steps)} de ${fmtN(g)} pasos; un paseo de 30 min te acerca.`, url: '/#hoy' }; },
  agua: date => { const v = (readJson(LOG_FILE, {})[`${date}|metric|agua`] || {}).value || 0, g = (readJson(path.join(DATA_DIR, 'food_goals.json'), {}) || {}).water_l || 2;
    if (v >= g * 0.5) return null;
    return { title: 'Te falta agua', body: `Llevas ${String(Math.round(v * 100) / 100).replace('.', ',')} de ${String(g).replace('.', ',')} L. Un vaso ahora.`, url: '/#comida' }; },
  semana: date => new Date(date + 'T12:00:00Z').getUTCDay() === 0 ? { title: 'Tu semana', body: 'Ya tienes el resumen de la semana: fuerza, cardio, sueño y progreso.', url: '/#semana' } : null,
  peso: date => { // ayer una serie clave llegó a las repeticiones de la regla → hoy, qué peso toca
    const st = trainSettings(), R = { top: 12, inc: 2, ...(st.rule || {}) }, y = new Date(Date.parse(date + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
    const hits = Object.values((readJson(TRAIN_FILE, {}) || {}).sessions || {}).filter(s => s.date === y && !(s.rpe >= 9))
      .flatMap(s => (s.sets || []).filter(x => x.key && x.reps >= R.top && x.kg != null).map(x => ({ kind: s.kind || 'fuerza', ex: x.ex, kg: x.kg + R.inc })));
    if (!hits.length) return null;
    const h = hits[0];
    return { title: 'Toca subir peso', body: `Próxima vez en ${h.kind}: ${h.ex}, sube a ${String(h.kg).replace('.', ',')} kg.`, url: '/#entreno' }; },
};
async function notifyTest(k) {  // prueba de un aviso concreto (Avisos → Probar): lo calcula ahora y lo manda si toca, sin contar en el límite
  if (k === 'valorar') { const r = pendingRating(madridNow().date, {}); if (!r) return { k, msg: null, nota: 'Ahora mismo no hay ninguna sesión de hoy sin valorar.' };
    return { k, msg: r.msg, sent: (readJson(PUSH_FILE, { subs: [] }).subs || []).length ? await pushAll(r.msg) : 0 }; }
  if (!NOTIFY_CHECK[k]) return { error: 'aviso' };
  const msg = NOTIFY_CHECK[k](madridNow().date);
  if (!msg) return { k, msg: null, nota: 'Ahora mismo no tocaría (por ejemplo, ya vas bien de pasos o de agua).' };
  return { k, msg, sent: (readJson(PUSH_FILE, { subs: [] }).subs || []).length ? await pushAll(msg) : 0 };
}
async function notifyTick() {
  const { date, time } = madridNow(), subs = readJson(PUSH_FILE, { subs: [] }).subs || [];
  if (!subs.length || time < '08:00' || time > '23:00') return null;
  let st = readJson(NOTIFY_FILE, {}); if (st.date !== date) st = { date, count: 0, done: {} };
  const P = notifyPrefs();
  for (const k of NOTIFY_ORDER) {
    const p = P[k]; if (!p.on || st.done[k] || !p.at || time < p.at || p.at < '08:00' || p.at > '23:00') continue;
    if (st.count >= 2) break;
    if (k === 'valorar') {  // no se marca como hecho del día: puede haber más de una sesión
      const r = pendingRating(date, st); if (!r) continue;
      st.valorados = [...(st.valorados || []), r.id]; st.count++; writeAtomic(NOTIFY_FILE, JSON.stringify(st));
      const n = await pushAll(r.msg); console.log('aviso valorar', date, n); return { k, msg: r.msg, sent: n }; }
    st.done[k] = time;
    let msg = null; try { msg = NOTIFY_CHECK[k](date); } catch (e) { console.error('aviso', k, e.message); }
    if (msg) st.count++;
    writeAtomic(NOTIFY_FILE, JSON.stringify(st));
    if (msg) { const n = await pushAll(msg); console.log('aviso', k, date, n); return { k, msg, sent: n }; }
  }
  return null;
}
setInterval(() => { notifyTick().catch(e => console.error('avisos', e.message)); }, 60e3);

// ---------- Sincronización con Garmin en el servidor (CLOUD_SYNC=1) ----------
const reqPending = st => !!st.requested && !st.done && Date.now() - Date.parse(st.requested) < SYNC_MAX_AGE;
const cloud = { child: null, lastStart: 0, again: false, fails: 0, warned: null };
if (CLOUD) {
  fs.mkdirSync(path.join(GARMIN_DIR, 'dashboard'), { recursive: true });
  try { cloud.lastStart = fs.statSync(path.join(GARMIN_DIR, 'cloud_sync.json')).mtimeMs; } catch {}
}
function cloudRun(full = false) {
  if (cloud.child) { cloud.again = true; return false; }
  const st = readJson(SYNC_FILE, {}), forReq = reqPending(st) ? st.requested : null;  // responde a la petición del móvil
  if (forReq) writeAtomic(SYNC_FILE, JSON.stringify({ ...st, started: new Date().toISOString() }));
  cloud.lastStart = Date.now();
  let out = '';
  const child = spawn('python3', [CLOUD_SCRIPT, ...(full ? ['--full'] : [])], {
    env: { ...process.env, FLY_URL: `http://127.0.0.1:${PORT}`, GARMINTOKENS: path.join(GARMIN_DIR, '.garminconnect'),
      TZ, SYNC_FORCE: forReq ? '1' : '', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cloud.child = child;
  const keep = b => { out = (out + b).slice(-12000); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const kill = setTimeout(() => child.kill('SIGKILL'), 20 * 60e3);
  let done = false;
  const finish = code => {
    if (done) return; done = true;
    clearTimeout(kill); cloud.child = null;
    try { fs.writeFileSync(path.join(GARMIN_DIR, 'cloud_sync.log'), `${new Date().toISOString()} código ${code}\n${out}`); } catch {}
    console.log('sync garmin', code === 0 ? 'ok' : `código ${code}`, out.trim().split('\n').slice(-1)[0] || '');
    const res = readJson(path.join(GARMIN_DIR, 'cloud_sync.json'), {});
    const error = code === 0 ? null : code === 3 ? 'Falta subir los datos iniciales desde el Mac' : String(res.error || out.trim().split('\n').pop() || 'error').slice(0, 200);
    if (forReq) {
      const s2 = readJson(SYNC_FILE, {});
      if (s2.requested === forReq) writeAtomic(SYNC_FILE, JSON.stringify({ ...s2, done: new Date().toISOString(), ok: code === 0, error }));
    }
    if (code === 3) cloud.lastStart = Date.now() - CLOUD_EVERY + 60e3;  // sin base inicial: se reintenta cada minuto
    else cloud.fails = code === 0 ? 0 : cloud.fails + 1;
    const today = madridNow().date;
    if (cloud.fails >= 3 && cloud.warned !== today) {  // un aviso al día si Garmin falla varias veces seguidas
      cloud.warned = today;
      pushAll({ title: 'Mi Garmin', body: `No consigo traer tus datos de Garmin: ${error}`, url: '/' }).catch(() => {});
    }
    if (code === 0) avisoSalud();
    if (cloud.again) { cloud.again = false; setTimeout(() => cloudTick(), 1000); }
  };
  child.on('close', finish);
  child.on('error', e => { out += `\n${e.message}`; finish(-1); });
  return true;
}
// Aviso diario de salud (sync/aviso_salud.py → GARMIN_DIR/aviso_salud.json): como mucho uno al día y solo con el sueño de hoy
const AVISO_FILE = path.join(GARMIN_DIR, 'aviso_salud.json'), AVISO_SENT = path.join(DATA_DIR, 'aviso_salud_enviado.json');
function avisoSalud() {
  try {
    const h = (readJson(AVISO_FILE, {}) || {}).hoy, today = madridNow().date;
    if (!h || !h.avisar || h.fecha !== today || h.nivel === 'sin_datos') return;
    if (!notifyPrefs().salud.on) return;
    if (readJson(AVISO_SENT, {}).date === today) return;
    const d = (readJson(DATA_FILE, {}).days || []).find(x => x.date === today);
    if (!d || d.sleep_h == null) return;
    writeAtomic(AVISO_SENT, JSON.stringify({ date: today, at: new Date().toISOString(), nivel: h.nivel }));
    pushAll({ title: h.titulo || 'Mi Garmin', body: h.texto || '', url: '/' }).catch(() => {});
  } catch (e) { console.error('aviso salud', e.message); }
}
function cloudTick() {
  if (!CLOUD || cloud.child) return;
  if (reqPending(readJson(SYNC_FILE, {})) || Date.now() - cloud.lastStart >= CLOUD_EVERY) cloudRun();
}
if (CLOUD) { setInterval(cloudTick, 60e3); setTimeout(cloudTick, 15e3); }
function readRaw(req, limit) {
  return new Promise((ok, ko) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { ko(new Error('demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', ko);
  });
}
const SEED_FILES = { 'garmin.db': b => b.subarray(0, 16).toString('latin1') === 'SQLite format 3\0', 'animo.csv': () => true };

const loginPage = (err = '') => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Mi Garmin">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1f2328"><title>Mi Garmin</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15171a;color:#e8e6e1;font:16px -apple-system,system-ui,sans-serif}
form{width:min(320px,88vw);display:grid;gap:12px}h1{font-size:22px;margin:0 0 4px;text-align:center}
input,button{font:inherit;font-size:17px;padding:12px 14px;border-radius:12px;border:1px solid #2e3237;background:#1e2125;color:inherit}
button{background:#2e8b57;border:0;font-weight:600}.e{color:#e6645a;font-size:14px;text-align:center;min-height:1em}</style></head>
<body><form method="post" action="/login"><img src="/icon-192.png" width="72" height="72" style="justify-self:center;border-radius:16px" alt="">
<h1>Mi Garmin</h1><input type="password" name="password" placeholder="Contraseña" autocomplete="current-password" autofocus required>
<button>Entrar</button><div class="e">${err}</div></form></body></html>`;

const STATIC = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = req.headers['fly-client-ip'] || req.socket.remoteAddress;
  try {
    if (p === '/healthz') return send(res, 200, 'ok');

    if (STATIC[p]) {
      const [f, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(PUB, f)), type, { 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400' });
    }
    // trazados del cuerpo para el mapa de músculos (datos de dibujo, sin nada personal)
    // y el catálogo de ejercicios y músculos (lo mismo que usa el conector); sin caché larga para que los cambios lleguen
    if (p === '/body-map.js' || p === '/exercises.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public-v2', p.slice(1))), 'text/javascript; charset=utf-8', { 'Cache-Control': p === '/body-map.js' ? 'public, max-age=86400' : 'no-cache' });

    if (p === '/login' && req.method === 'GET') return send(res, 200, loginPage(), 'text/html; charset=utf-8');
    if (p === '/login' && req.method === 'POST') {
      if (tooMany(ip)) return send(res, 429, loginPage('Demasiados intentos. Prueba en 15 minutos.'), 'text/html; charset=utf-8');
      const pw = new URLSearchParams(await readBody(req, 4096)).get('password') || '';
      if (!same(pw, APP_PASSWORD)) {
        tries.get(ip).push(Date.now());
        return send(res, 401, loginPage('Contraseña incorrecta'), 'text/html; charset=utf-8');
      }
      const exp = String(Date.now() + SESSION_DAYS * 864e5);
      return send(res, 303, '', 'text/plain', {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${exp}.${sign(exp)}; Max-Age=${SESSION_DAYS * 86400}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      });
    }
    if (p === '/logout') return send(res, 303, '', 'text/plain', { Location: '/login', 'Set-Cookie': `${COOKIE}=; Max-Age=0; Path=/` });
    if (await foodApp(req, res, p, url, { session: sessionOk(req), bearer: bearerOk(req) }) !== false) return;
    if (await trainApp(req, res, p, url, { session: sessionOk(req), bearer: bearerOk(req) }) !== false) return;

    // Rutas del Mac (token)
    if (p === '/api/upload' && req.method === 'POST') {
      if (!bearerOk(req)) return json(res, 401, { error: 'token' });
      let text = (await readBody(req, 20e6)).trim();
      text = text.replace(/^window\.GARMIN_DATA\s*=\s*/, '').replace(/;\s*$/, '');
      const data = JSON.parse(text);
      if (!Array.isArray(data.days)) return json(res, 400, { error: 'formato' });
      writeAtomic(DATA_FILE, JSON.stringify(data));
      return json(res, 200, { ok: true, days: data.days.length, generated_at: data.generated_at });
    }
    if (p === '/api/mood/export' && req.method === 'GET') {
      if (!bearerOk(req)) return json(res, 401, { error: 'token' });
      return json(res, 200, readJson(MOOD_FILE, []));
    }
    if (p === '/api/sync/pending' && req.method === 'GET') {
      if (!bearerOk(req)) return json(res, 401, { error: 'token' });
      const st = readJson(SYNC_FILE, {});
      const pending = !CLOUD && reqPending(st);  // con CLOUD_SYNC=1 el Mac ya no sincroniza
      return json(res, 200, { pending, requested: st.requested || null });
    }
    if (p === '/api/sync/done' && req.method === 'POST') {
      if (!bearerOk(req)) return json(res, 401, { error: 'token' });
      const b = JSON.parse((await readBody(req, 4096)) || '{}'), st = readJson(SYNC_FILE, {}), now = new Date().toISOString();
      if (!st.requested) return json(res, 200, { ok: true, idle: true });
      if (b.state === 'running') st.started = now;      // el Mac ha empezado
      else Object.assign(st, { done: now, ok: b.ok !== false, error: b.ok === false ? String(b.error || 'error').slice(0, 200) : null });
      writeAtomic(SYNC_FILE, JSON.stringify(st));
      return json(res, 200, st);
    }
    if (p.startsWith('/api/cloud/')) {
      if (!bearerOk(req)) return json(res, 401, { error: 'token' });
      if (p === '/api/cloud/status') {
        let log = ''; try { log = fs.readFileSync(path.join(GARMIN_DIR, 'cloud_sync.log'), 'utf8').slice(-4000); } catch {}
        return json(res, 200, { enabled: CLOUD, running: !!cloud.child, db: fs.existsSync(path.join(GARMIN_DIR, 'garmin.db')),
          last: readJson(path.join(GARMIN_DIR, 'cloud_sync.json'), null), log });
      }
      if (p === '/api/cloud/run' && req.method === 'POST') {
        if (!CLOUD) return json(res, 409, { error: 'CLOUD_SYNC no está activado' });
        return json(res, 200, { started: cloudRun(url.searchParams.get('full') === '1'), running: true });
      }
      const files = { '/api/cloud/db': ['garmin-copia.db', 'application/vnd.sqlite3'], '/api/cloud/datajs': ['dashboard/data.js', 'text/javascript; charset=utf-8'] };
      if (files[p] && req.method === 'GET') {
        const f = path.join(GARMIN_DIR, files[p][0]);
        if (!fs.existsSync(f)) return json(res, 404, { error: 'aún no hay copia' });
        return send(res, 200, fs.readFileSync(f), files[p][1]);
      }
      if (p === '/api/cloud/seed' && req.method === 'POST') {
        const name = url.searchParams.get('file'), check = SEED_FILES[name];
        if (!check) return json(res, 400, { error: 'archivo' });
        if (cloud.child) return json(res, 409, { error: 'hay una sincronización en marcha, prueba en un minuto' });
        const f = path.join(GARMIN_DIR, name);
        if (fs.existsSync(f) && url.searchParams.get('force') !== '1') return json(res, 409, { error: 'ya existe' });
        const body = await readRaw(req, 200e6);
        if (!body.length || !check(body)) return json(res, 400, { error: 'contenido' });
        fs.mkdirSync(GARMIN_DIR, { recursive: true });
        writeAtomic(f, body);
        return json(res, 200, { ok: true, file: name, bytes: body.length });
      }
      return json(res, 404, { error: 'ruta' });
    }
    if (p === '/api/log/export' && req.method === 'GET') {
      if (!bearerOk(req)) return json(res, 401, { error: 'token' });
      return json(res, 200, { config: readJson(CONFIG_FILE, DEFAULT_CONFIG), entries: Object.values(readJson(LOG_FILE, {})) });
    }

    // Todo lo demás requiere sesión
    if (!sessionOk(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'login' });
      return send(res, 303, '', 'text/plain', { Location: '/login' });
    }
    if (p === '/' || p === '/index.html' || p === '/v2' || p === '/v2/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public-v2', 'index.html')), 'text/html; charset=utf-8');  // app principal (v2)
    if (p === '/v1' || p === '/v1/') return send(res, 200, fs.readFileSync(path.join(PUB, 'index.html')), 'text/html; charset=utf-8');  // app anterior, por si acaso
    if (p === '/api/data') {
      if (!fs.existsSync(DATA_FILE)) return json(res, 200, null);
      return send(res, 200, fs.readFileSync(DATA_FILE), 'application/json; charset=utf-8');
    }
    if (p === '/api/aviso-salud' && req.method === 'GET') return json(res, 200, readJson(AVISO_FILE, null));
    if (p === '/api/mood' && req.method === 'GET') return json(res, 200, readJson(MOOD_FILE, []).slice(-400));  // varios registros al día
    if (p === '/api/mood' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 8192));
      const clamp = v => (v == null || v === '' ? null : Math.min(5, Math.max(1, Math.round(Number(v)))));
      const ts = typeof b.ts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b.ts) ? b.ts.slice(0, 19) : new Date().toISOString().slice(0, 19);
      const entry = { ts, mood: clamp(b.mood), energy: clamp(b.energy), note: String(b.note || '').replace(/[\r\n,]+/g, ' ').slice(0, 300) };
      if (entry.mood == null) return json(res, 400, { error: 'ánimo' });
      const all = readJson(MOOD_FILE, []); all.push(entry);
      writeAtomic(MOOD_FILE, JSON.stringify(all));
      return json(res, 200, entry);
    }
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, readJson(CONFIG_FILE, DEFAULT_CONFIG));
    if (p === '/api/config' && req.method === 'PUT') {
      const b = JSON.parse(await readBody(req, 32768));
      const clean = (arr, extra) => (Array.isArray(arr) ? arr : []).slice(0, 40)
        .filter(x => x && KEY_RE.test(x.key) && typeof x.label === 'string')
        .map(x => ({ key: x.key, label: x.label.slice(0, 60), ...extra(x) }));
      const cfg = {
        habits: clean(b.habits, () => ({})),
        metrics: clean(b.metrics, x => ({ unit: String(x.unit || '').slice(0, 12), step: Number(x.step) > 0 ? Number(x.step) : 1 })),
      };
      writeAtomic(CONFIG_FILE, JSON.stringify(cfg));
      return json(res, 200, cfg);
    }
    if (p === '/api/log' && req.method === 'GET') {
      const since = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
      return json(res, 200, Object.values(readJson(LOG_FILE, {})).filter(e => e.date >= since));
    }
    if (p === '/api/log' && req.method === 'POST') {
      // Un registro por día, tipo y clave: guardar de nuevo lo sustituye; value null lo borra
      const b = JSON.parse(await readBody(req, 8192));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !['habit', 'metric', 'sick'].includes(b.kind) || !KEY_RE.test(b.key))
        return json(res, 400, { error: 'registro' });
      const v = b.value == null || b.value === '' ? null : Number(b.value);
      if (v != null && !Number.isFinite(v)) return json(res, 400, { error: 'valor' });
      const all = readJson(LOG_FILE, {}), id = `${b.date}|${b.kind}|${b.key}`;
      if (v == null) delete all[id];
      else all[id] = { date: b.date, kind: b.kind, key: b.key, value: v, ...(b.note ? { note: String(b.note).replace(/[\r\n,]+/g, ' ').slice(0, 200) } : {}), ts: new Date().toISOString().slice(0, 19) };  // sick: estoy mala (nivel 0-3, síntomas, nota)
      writeAtomic(LOG_FILE, JSON.stringify(all));
      return json(res, 200, all[id] || { deleted: id });
    }
    if (p === '/api/sync/status' && req.method === 'GET') {
      const st = readJson(SYNC_FILE, {});
      let generated_at = null; try { generated_at = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).generated_at || null; } catch {}
      return json(res, 200, { requested: st.requested || null, started: st.started || null, done: st.done || null,
        ok: st.ok ?? null, error: st.error || null, generated_at, gap_min: SYNC_GAP / 60e3, mode: CLOUD ? 'server' : 'mac' });
    }
    if (p === '/api/sync/request' && req.method === 'POST') {
      const st = readJson(SYNC_FILE, {}), now = Date.now();
      const pending = !!st.requested && !st.done && now - Date.parse(st.requested) < SYNC_MAX_AGE;
      if (st.requested && now - Date.parse(st.requested) < SYNC_GAP)
        return json(res, pending ? 200 : 429, { ...st, pending, again_at: new Date(Date.parse(st.requested) + SYNC_GAP).toISOString() });
      const next = { requested: new Date(now).toISOString() };
      writeAtomic(SYNC_FILE, JSON.stringify(next));
      if (CLOUD) cloudRun();
      return json(res, 200, { ...next, pending: true });
    }
    if (p === '/api/push/key') return json(res, 200, { key: b64u(vapidPub), at: notifyPrefs().registro.at || REMIND_AT });
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const sub = JSON.parse(await readBody(req, 8192));
      if (!/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json(res, 400, { error: 'suscripción' });
      const st = readJson(PUSH_FILE, { subs: [] });
      st.subs = st.subs.filter(x => x.endpoint !== sub.endpoint).concat({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
      writeAtomic(PUSH_FILE, JSON.stringify(st));
      return json(res, 200, { ok: true, subs: st.subs.length });
    }
    if (p === '/api/push/unsubscribe' && req.method === 'POST') {
      const { endpoint } = JSON.parse(await readBody(req, 8192)), st = readJson(PUSH_FILE, { subs: [] });
      st.subs = st.subs.filter(x => x.endpoint !== endpoint);
      writeAtomic(PUSH_FILE, JSON.stringify(st));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/push/test' && req.method === 'POST') {
      if (url.searchParams.get('aviso')) return json(res, 200, await notifyTest(url.searchParams.get('aviso')));
      return json(res, 200, await pushAll({ title: 'Mi Garmin', body: `Así te llegará el recordatorio de las ${notifyPrefs().registro.at || REMIND_AT}.`, url: '/#registro' }));
    }
    return send(res, 404, 'No encontrado');
  } catch (e) {
    console.error(p, e.message);
    return json(res, 400, { error: e.message });
  }
});
server.listen(PORT, '0.0.0.0', () => console.log('Mi Garmin en el puerto', PORT));
