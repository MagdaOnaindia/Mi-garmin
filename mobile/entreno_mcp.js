// Herramientas de Entreno para el conector de Claude (/comida/mcp, el mismo token que las de comida).
// Leen las actividades de Garmin (data.json) y guardan en train.json con las mismas reglas que la pestaña Entreno (entreno.js).
'use strict';
const path = require('path');
const { DATE, ID, KINDS, MUSCLES, sessionFrom, settingsFrom } = require('./entreno').rules;
const EX = require('./public-v2/exercises.js');   // «Mis ejercicios»: lo mismo que la app (catálogo, músculos, otros nombres)

module.exports = function entrenoMcp({ DATA_DIR, readJson, writeAtomic }) {
  const FILE = path.join(DATA_DIR, 'train.json'), DATA_FILE = path.join(DATA_DIR, 'data.json');
  const DEF_PLANS = {  // los mismos que trae la app si no los has cambiado
    Legs: ['Sentadilla búlgara', 'Extensión de cuádriceps', 'Step up', 'Peso muerto rumano en polea', 'Goblet squat con talones elevados'],
    Push: ['Press banca inclinado', 'Press de hombro sentada', 'Tríceps en polea', 'Elevaciones laterales y frontales'],
    Pull: ['Jalón al pecho', 'Remo', 'Face pull sentada', 'Bíceps', 'Extensión lumbar', 'Abdominales (opcional)'],
    Movilidad: ['Hip thrust a una pierna', 'Split squat con mancuernas', 'Paseo de maleta'],
  };
  const STRENGTH = ['Push', 'Pull', 'Legs', 'Fuerza'];   // movilidad/calentamiento no cuenta para el objetivo de fuerza
  const load = () => { const d = readJson(FILE, {}); return { sessions: d.sessions || {}, settings: d.settings || {} }; };
  const save = all => writeAtomic(FILE, JSON.stringify(all));
  const lib = st => EX.library((st || {}).exercises);
  // Igual que la app: los tipos con entrenamiento en Garmin Connect toman de ahí ejercicios, orden, series y reps
  const GX_ES = { PULL_UP: 'Jalón / dominadas', ROW: 'Remo', BENCH_PRESS: 'Press de banca', SHOULDER_PRESS: 'Press de hombro', TRICEPS_EXTENSION: 'Extensión de tríceps', LATERAL_RAISE: 'Elevaciones laterales',
    CURL: 'Curl de bíceps', HYPEREXTENSION: 'Extensión lumbar', CRUNCH: 'Abdominales', SIT_UP: 'Abdominales', LUNGE: 'Zancada', SQUAT: 'Sentadilla', DEADLIFT: 'Peso muerto', HIP_RAISE: 'Puente de glúteo',
    PLANK: 'Plancha', CARRY: 'Paseo con peso', CALF_RAISE: 'Elevación de talones', LEG_CURL: 'Curl femoral', LEG_RAISE: 'Elevación de piernas', HIP_STABILITY: 'Estabilidad de cadera', CORE: 'Core',
    SHRUG: 'Encogimientos', FLYE: 'Aperturas', PUSH_UP: 'Flexiones', CHOP: 'Leñador', HIP_SWING: 'Swing con kettlebell', TOTAL_BODY: 'Cuerpo completo', WARM_UP: 'Calentamiento', PLYO: 'Pliometría', CARDIO: 'Cardio', BANDED_EXERCISES: 'Ejercicio con banda' };
  const stepName = st => String(st.notes || '').replace(/^[A-Z]\d*\.\s*/, '').split(/:|\s\(/)[0].trim();
  const exLabel = x => !x ? '' : GX_ES[x.category] || String(x.label || x.name || x.category || '').replace(/_/g, ' ').toLowerCase().replace(/^./, m => m.toUpperCase());
  const stepKey = st => norm(stepName(st)) || norm([st.exercise && st.exercise.category, st.exercise && st.exercise.name].filter(Boolean).join('/'));
  function connectPlans(st) {
    const W = readJson(DATA_FILE, {}).garmin_workouts || [], map = st.exmap || {}, saved = Object.values({ ...DEF_PLANS, ...(st.plans || {}) }).flat(), pick = {}, out = {};
    for (const w of W) { const k = kindOf({ name: w.name }, null); if (!k || !KINDS.includes(k) || k === 'Otro') continue; if (!pick[k] || (w.updated || '') > (pick[k].updated || '')) pick[k] = w; }
    for (const [k, w] of Object.entries(pick)) {
      const list = [];
      (w.steps || []).forEach((sx, i) => {
        const key = stepKey(sx); if (!key) return;
        let e = list.find(x => x.key === key);
        if (!e) { const raw = stepName(sx) || exLabel(sx.exercise), r = norm(raw);
          const name = map[key] || (lib(st).info(raw) && lib(st).canon(raw)) || saved.find(x => norm(x) === r) || saved.find(x => r.startsWith(norm(x)) || norm(x).startsWith(r)) || raw;
          e = { key, name, cat: sx.exercise && sx.exercise.category, n: 0, maxSets: 0, reps: sx.reps ?? null, secs: sx.duration_s ?? null, kg: sx.weight_kg ?? null, xname: sx.exercise && sx.exercise.name, idx: [] }; list.push(e); }
        e.n++; e.maxSets = Math.max(e.maxSets, sx.sets || 0); if (sx.fit_index != null) e.idx.push(sx.fit_index);  // step_index de las series del reloj = fit_index
      });
      list.forEach(e => { e.sets = e.maxSets > 1 ? e.maxSets : e.n; });
      out[k] = { workout: w, list };
    }
    return out;
  }
  const plans = st => { const c = connectPlans(st), o = { ...DEF_PLANS, ...(st.plans || {}) }; for (const k in c) o[k] = c[k].list.map(x => x.name); return o; };
  function watchSets(ws, kind, st) {
    const A = ((ws && ws.sets) || []).filter(x => x.set_type === 'ACTIVE'); if (!A.length) return null;
    const cp = connectPlans(st)[kind], same = cp && ws.workout_id != null && String(cp.workout.id) === String(ws.workout_id), by = new Map();
    for (const x of A) {
      let name = null; const c = x.exercise && x.exercise.category;
      if (same && x.step_index != null && (cp.workout.rest_idx || []).includes(x.step_index)) continue;   // movimiento durante un descanso
      if (same && x.step_index != null) { const e = cp.list.find(y => y.idx.includes(x.step_index)); if (e && (!c || !e.cat || e.cat === c)) name = e.name; }
      const xn = x.exercise && x.exercise.name;
      if (!name && cp && c && xn) { const hit = cp.list.filter(y => y.cat === c && y.xname === xn); if (hit.length === 1) name = hit[0].name; }
      if (!name && cp && c) { const hit = cp.list.filter(y => y.cat === c); if (hit.length === 1) name = hit[0].name; }
      if (!name && (!c || c === 'UNKNOWN')) continue;   // el reloj no supo qué era
      name = lib(st).canon(name || exLabel(x.exercise));
      let kg = x.weight_kg; if (kg != null && kg > 500) kg = kg / 1000;
      const g = by.get(name) || { ex: name, series: 0, reps: null, kg: null }; g.series++;
      if (x.reps != null) g.reps = Math.max(g.reps || 0, x.reps); if (kg != null && kg > 0) g.kg = Math.max(g.kg || 0, Math.round(kg * 10) / 10); by.set(name, g);
    }
    return [...by.values()];
  }
  const rule = st => ({ top: 12, inc: 2, ...(st.rule || {}) });
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  // Igual que la app: qué tipo de sesión es según el nombre de Garmin, si no lo has dicho tú
  const WORKOUT_KIND = { 'fuerza: cadera y core': 'Fuerza', 'movilidad: calentamiento': 'Movilidad', movilidad: 'Movilidad', legs: 'Legs', push: 'Push', pull: 'Pull' };
  function kindOf(a, s) {
    if (s && s.kind) return s.kind;
    const n = (a.name || '').toLowerCase();
    // primero el nombre exacto de tus entrenamientos de Connect; las palabras clave, solo si no coincide
    const W = WORKOUT_KIND[n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()]; if (W) return W;
    if (/\bpush\b|empuje/.test(n)) return 'Push';
    if (/\bpull\b|espalda|tir[oó]n/.test(n)) return 'Pull';
    if (/\blegs?\b|pierna/.test(n)) return 'Legs';
    if (/movilidad|psoas|cadera|lumbar/.test(n) || a.category === 'Movilidad') return 'Movilidad';
    if (a.category === 'HIIT') return 'Funcional';
    if (a.category === 'Fuerza') return null;
    return a.category || 'Otro';
  }
  function sessions() {
    const { sessions: T, settings: st } = load(), data = readJson(DATA_FILE, {}), acts = data.activities || [], out = [], seen = new Set();
    const AS = data.activity_sets || {}, WB = Object.fromEntries((data.garmin_workouts || []).map(w => [String(w.id), w.name]));
    for (const a of acts) {
      const id = String(a.id), s = T[id] || {}, ws = AS[id]; seen.add(id);
      const wn = ws && (ws.workout_name || (ws.workout_id != null && WB[String(ws.workout_id)])), tipo = kindOf(wn ? { ...a, name: wn } : a, s);
      const watch = !(s.sets && s.sets.length) && ws ? watchSets(ws, tipo, st) : null;
      out.push({ id, fecha: a.date, hora: (a.start_local || '').slice(11, 16) || undefined, garmin: wn || a.name, tipo, ...(watch ? { series_del_reloj: true } : {}),
        minutos: a.duration_s ? Math.round(a.duration_s / 60) : a.minutes ?? null, fc_media: a.avg_hr ?? undefined, kcal: a.kcal ?? undefined,
        rpe: s.rpe ?? a.rpe ?? null, fuerza: s.strength ?? undefined, molestias: s.pain || undefined, nota: s.note || undefined, ejercicios: (s.sets && s.sets.length ? s.sets : watch) || [] });
    }
    for (const s of Object.values(T)) if (s.manual && !seen.has(s.id))
      out.push({ id: s.id, fecha: s.date, manual: true, tipo: s.kind, minutos: s.minutes ?? null, rpe: s.rpe ?? null, molestias: s.pain || undefined, nota: s.note || undefined, ejercicios: s.sets || [] });
    return out.sort((a, b) => (a.fecha + (a.hora || '')).localeCompare(b.fecha + (b.hora || '')));
  }
  const compact = s => ({ ...s, ejercicios: (s.ejercicios || []).map(x => `${x.ex}: ${x.series || 3}×${x.reps ?? '?'}${x.kg != null ? ` · ${x.kg} kg` : ''}`), pendiente_valorar: s.rpe == null || undefined });
  function find(id) {
    if (!ID.test(String(id || ''))) throw new Error('id de sesión no válido; usa ver_entrenos');
    const s = sessions().find(x => x.id === String(id));
    if (!s) throw new Error(`No hay ninguna sesión con id ${id}; usa ver_entrenos o crear_entreno`);
    return s;
  }
  // Guarda cambios en la valoración de una sesión (lo que no se pasa se conserva)
  function patch(s, b) {
    const all = load(), prev = all.sessions[s.id] || (s.manual ? {} : { date: s.fecha });
    all.sessions[s.id] = sessionFrom(s.id, { date: s.fecha, ...b }, prev);
    save(all);
    return all.sessions[s.id];
  }
  // Nombre del ejercicio tal como está en el plan o en tu historial, para que la app lo reconozca
  function exName(name, kind, st) {
    const L = lib(st), c = L.canon(name); if (L.L[c]) return c;   // primero «Mis ejercicios» y sus otros nombres
    const n = norm(name), pool = [...(plans(st)[kind] || []), ...Object.values(plans(st)).flat(), ...Object.values(load().sessions).flatMap(s => (s.sets || []).map(x => x.ex))];
    return pool.find(x => norm(x) === n) || pool.find(x => norm(x).startsWith(n) || n.startsWith(norm(x))) || String(name).trim().slice(0, 60);
  }
  function progression(ex, st) {
    const R = rule(st), cn = lib(st).canon, c = cn(ex), same = x => cn(x.ex) === c;
    const H = sessions().filter(s => (s.ejercicios || []).some(same)).map(s => ({ fecha: s.fecha, rpe: s.rpe, ...s.ejercicios.find(same) }));
    const last = H[H.length - 1];
    let proxima = 'Sin datos todavía';
    if (last) proxima = last.reps >= R.top && !(last.rpe >= 9) ? (last.kg != null ? `Sube a ${last.kg + R.inc} kg` : 'Sube el peso')
      : last.rpe >= 9 && last.reps >= R.top ? 'Mantén el peso: el RPE fue alto' : `Mismo peso, busca ${R.top} repeticiones`;
    return { ejercicio: ex, historial: H.slice(-10).map(h => `${h.fecha}: ${h.series || 3}×${h.reps ?? '?'}${h.kg != null ? ` · ${h.kg} kg` : ''}${h.rpe ? ` (RPE ${h.rpe})` : ''}`), proxima_vez: proxima,
      regla: `Doble progresión: cuando hagas todas las series a ${R.top} repeticiones (y el RPE no sea 9-10), sube ${R.inc} kg.` };
  }

  const S = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
  const TIPOS = KINDS.join(', ');
  const TOOLS = [
    { name: 'ver_entrenos', description: `Lista las sesiones de entreno de Magdalena (las del reloj Garmin y las añadidas a mano) con su id, tipo (${TIPOS}), minutos, pulso, RPE, notas y ejercicios apuntados. Por defecto, las últimas 2 semanas. Úsala primero para encontrar el id de la sesión de la que habla ("la de hoy", "la de pull del martes").`,
      inputSchema: S({ desde: { type: 'string', description: 'AAAA-MM-DD' }, hasta: { type: 'string', description: 'AAAA-MM-DD' } }) },
    { name: 'ver_entreno', description: 'Detalle de una sesión: todo lo apuntado, los ejercicios de su plan con los pesos de la última vez y qué toca subir.',
      inputSchema: S({ id: { type: 'string' } }, ['id']) },
    { name: 'valorar_entreno', description: `Cambia la valoración de una sesión: tipo (${TIPOS}), rpe (esfuerzo 1-10: 1-3 suave, 4-6 moderado, 7-8 duro, 9-10 máximo), nota, molestias (dolor o zona que molestó), fuerza (true si cuenta como sesión de fuerza), minutos y fecha (estas dos solo en sesiones a mano). Solo cambia lo que pases.`,
      inputSchema: S({ id: { type: 'string' }, tipo: { type: 'string', enum: KINDS }, rpe: { type: 'number', minimum: 1, maximum: 10 }, nota: { type: 'string' }, molestias: { type: 'string' },
        fuerza: { type: 'boolean' }, minutos: { type: 'number' }, fecha: { type: 'string', description: 'AAAA-MM-DD' } }, ['id']) },
    { name: 'crear_entreno', description: 'Añade una sesión hecha sin el reloj (por ejemplo, si olvidó grabarla). Después puedes apuntar sus series con apuntar_series.',
      inputSchema: S({ fecha: { type: 'string', description: 'AAAA-MM-DD; por defecto hoy' }, tipo: { type: 'string', enum: KINDS }, minutos: { type: 'number' }, rpe: { type: 'number', minimum: 1, maximum: 10 }, nota: { type: 'string' } }, ['tipo']) },
    { name: 'apuntar_series', description: 'Apunta lo que hizo en cada ejercicio de una sesión: series, repeticiones y kg (como en la app: una línea por ejercicio). Si un ejercicio ya estaba apuntado en esa sesión, se sustituye. Si hizo series distintas, apunta la que mejor la represente (la última o la más pesada) y explica el resto en la nota. Si el ejercicio no está en el plan de ese tipo de sesión, se añade al plan para que salga en la app.',
      inputSchema: S({ id: { type: 'string' }, ejercicios: { type: 'array', items: S({ ejercicio: { type: 'string' }, series: { type: 'number', minimum: 1, maximum: 10 }, reps: { type: 'number', minimum: 1, maximum: 100 }, kg: { type: 'number', minimum: 0, maximum: 500 } }, ['ejercicio']) } }, ['id', 'ejercicios']) },
    { name: 'borrar_ejercicio', description: 'Quita un ejercicio apuntado en una sesión.',
      inputSchema: S({ id: { type: 'string' }, ejercicio: { type: 'string' } }, ['id', 'ejercicio']) },
    { name: 'borrar_entreno', description: 'En una sesión añadida a mano, la borra. En una del reloj, borra solo lo apuntado (RPE, notas, series); la actividad de Garmin sigue ahí. Pide confirmación a Magdalena antes de usarla.',
      inputSchema: S({ id: { type: 'string' } }, ['id']) },
    { name: 'ver_progresion', description: 'Historial de un ejercicio (o de todos los de un tipo de sesión) y qué peso toca la próxima vez según su regla de doble progresión.',
      inputSchema: S({ ejercicio: { type: 'string' }, tipo: { type: 'string', enum: KINDS } }) },
    { name: 'ver_mis_ejercicios', description: 'Su lista «Mis ejercicios»: para cada uno, nota, músculos principales y secundarios y otros nombres con los que llega del reloj o de Garmin Connect. También los «sin definir» (llegaron del reloj sin nombre suyo o sin músculos). Con catalogo=true añade el catálogo de ejercicios habituales que aún no ha hecho. Úsala para saber cómo se llama un ejercicio en su app antes de apuntarlo.',
      inputSchema: S({ catalogo: { type: 'boolean' }, ejercicio: { type: 'string', description: 'solo este (por su nombre o por otro nombre)' } }) },
    { name: 'editar_ejercicio', description: `Crea o cambia un ejercicio de «Mis ejercicios»: nuevo_nombre (renombrar: el nombre viejo queda como otro nombre y se cambia en sus planes), nota, principales y secundarios (lista completa de músculos: ${MUSCLES.join(', ')}), otros_nombres_anadir / otros_nombres_quitar (cómo sale en el reloj, por ejemplo «Bíceps» o «Aperturas»). Con es_el_mismo_que, el nombre pasa a ser otro nombre de ese ejercicio (para los «sin definir»). Solo cambia lo que pases.`,
      inputSchema: S({ nombre: { type: 'string' }, nuevo_nombre: { type: 'string' }, nota: { type: 'string' }, principales: { type: 'array', items: { type: 'string', enum: MUSCLES } }, secundarios: { type: 'array', items: { type: 'string', enum: MUSCLES } },
        otros_nombres_anadir: { type: 'array', items: { type: 'string' } }, otros_nombres_quitar: { type: 'array', items: { type: 'string' } }, es_el_mismo_que: { type: 'string' } }, ['nombre']) },
    { name: 'ver_ajustes_entreno', description: 'Su regla de progresión, los ejercicios de cada tipo de sesión (planes) y sus objetivos semanales.', inputSchema: S({}) },
    { name: 'cambiar_ajustes_entreno', description: 'Cambia la regla de progresión (repeticiones objetivo y kg que sube), los ejercicios de un tipo de sesión (lista completa y en orden) u objetivos (sueño en h, pasos, minutos de intensidad a la semana, sesiones de fuerza a la semana, hora de acostarse HH:MM). Solo cambia lo que pases.',
      inputSchema: S({ regla: S({ reps: { type: 'number' }, sube_kg: { type: 'number' } }), planes: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: `{"Push": ["Press banca inclinado", ...]}; tipos: ${TIPOS}` },
        objetivos: S({ sueno_h: { type: 'number' }, pasos: { type: 'number' }, min_intensidad: { type: 'number' }, sesiones_fuerza: { type: 'number' }, acostarse: { type: 'string' } }) }) },
  ];

  function call(name, a) {
    const st = () => load().settings;
    if (name === 'ver_entrenos') {
      const hasta = DATE.test(a.hasta) ? a.hasta : today(), desde = DATE.test(a.desde) ? a.desde : addDays(hasta, -13);
      return { desde, hasta, sesiones: sessions().filter(s => s.fecha >= desde && s.fecha <= hasta).map(compact) };
    }
    if (name === 'ver_entreno') {
      const s = find(a.id), P = plans(st())[s.tipo] || [];
      return { ...compact(s), plan: P.map(ex => progression(ex, st())).map(p => ({ ejercicio: p.ejercicio, objetivo_connect: (() => { const e = connectPlans(st())[s.tipo]?.list.find(x => x.name === p.ejercicio); return e ? `${e.sets} × ${e.reps ?? (e.secs ? Math.round(e.secs) + ' s' : '?')}` : undefined; })(), ultima_vez: p.historial[p.historial.length - 1] || null, proxima_vez: p.proxima_vez })) };
    }
    if (name === 'valorar_entreno') {
      const s = find(a.id), b = {};
      if (a.tipo !== undefined) { if (!KINDS.includes(a.tipo)) throw new Error(`tipo no válido; usa uno de: ${TIPOS}`); b.kind = a.tipo; if (a.fuerza === undefined) b.strength = STRENGTH.includes(a.tipo) || null; }
      if (a.rpe !== undefined) { if (!(a.rpe >= 1 && a.rpe <= 10)) throw new Error('rpe de 1 a 10'); b.rpe = Math.round(a.rpe); }
      if (a.nota !== undefined) b.note = a.nota;
      if (a.molestias !== undefined) b.pain = a.molestias;
      if (a.fuerza !== undefined) b.strength = !!a.fuerza;
      if (s.manual && a.minutos !== undefined) b.minutes = a.minutos;
      if (s.manual && a.fecha !== undefined) { if (!DATE.test(a.fecha)) throw new Error('fecha AAAA-MM-DD'); b.date = a.fecha; }
      if (!Object.keys(b).length) throw new Error('no hay nada que cambiar');
      const r = patch(s, b);
      return { guardado: compact(sessions().find(x => x.id === r.id)) };
    }
    if (name === 'crear_entreno') {
      if (!KINDS.includes(a.tipo)) throw new Error(`tipo no válido; usa uno de: ${TIPOS}`);
      const fecha = a.fecha == null ? today() : a.fecha; if (!DATE.test(fecha)) throw new Error('fecha AAAA-MM-DD');
      const id = 'm' + Date.now().toString(36), all = load();
      all.sessions[id] = sessionFrom(id, { date: fecha, manual: true, kind: a.tipo, minutes: a.minutos, rpe: a.rpe, note: a.nota, strength: STRENGTH.includes(a.tipo) });
      save(all);
      return { creado: compact(sessions().find(x => x.id === id)) };
    }
    if (name === 'apuntar_series') {
      const s = find(a.id), list = (a.ejercicios || []).slice(0, 20);
      if (!list.length) throw new Error('no hay ejercicios');
      const all = load(), set = all.settings, kind = s.tipo, sets = (all.sessions[s.id]?.sets?.length ? all.sessions[s.id].sets : s.ejercicios || []).map(x => ({ ex: x.ex, series: x.series, reps: x.reps, kg: x.kg })), added = [], fuera = [];  // si no hay nada guardado, parte de lo del reloj
      for (const e of list) {
        if (!e.ejercicio || !String(e.ejercicio).trim()) throw new Error('falta el nombre del ejercicio');
        for (const [k, lo, hi] of [['series', 1, 10], ['reps', 1, 100], ['kg', 0, 500]]) if (e[k] != null && !(e[k] >= lo && e[k] <= hi)) throw new Error(`${k} fuera de rango (${lo}-${hi}) en ${e.ejercicio}`);
        const ex = exName(e.ejercicio, kind, set), row = { ex, series: e.series ?? 3, reps: e.reps ?? null, kg: e.kg ?? null }, i = sets.findIndex(x => x.ex === ex);
        if (i >= 0) sets[i] = row; else sets.push(row);
        // la app enseña los ejercicios del plan de ese tipo: si no está, se añade al final
        if (kind && KINDS.includes(kind)) { const P = plans(set); if (!(P[kind] || []).includes(ex)) { if (connectPlans(set)[kind]) fuera.push(ex); else { set.plans = { ...(set.plans || {}), [kind]: [...(P[kind] || []), ex].slice(0, 15) }; added.push(ex); } } }
      }
      all.settings = settingsFrom({ plans: set.plans }, set);
      all.sessions[s.id] = sessionFrom(s.id, { date: s.fecha, sets, ...(s.tipo && !all.sessions[s.id]?.kind ? { kind: s.tipo } : {}) }, all.sessions[s.id] || (s.manual ? {} : { date: s.fecha }));
      save(all);
      return { sesion: compact(sessions().find(x => x.id === s.id)), anadidos_al_plan: added.length ? added : undefined,
        fuera_del_plan_de_connect: fuera.length ? `${fuera.join(', ')}: se guarda en la sesión, pero ${kind} viene de su entrenamiento de Garmin Connect; para que salga en el plan, que lo añada allí.` : undefined,
        proxima_vez: list.map(e => progression(exName(e.ejercicio, kind, load().settings), load().settings)).map(p => `${p.ejercicio}: ${p.proxima_vez}`),
        aviso: kind ? undefined : 'La sesión no tiene tipo: dile a Magdalena qué fue (valorar_entreno con tipo) para que salga en su plan.' };
    }
    if (name === 'borrar_ejercicio') {
      const s = find(a.id), all = load(), cur = all.sessions[s.id];
      const ex = cur && (cur.sets || []).find(x => norm(x.ex) === norm(a.ejercicio) || norm(x.ex).startsWith(norm(a.ejercicio)));
      if (!ex) throw new Error(`"${a.ejercicio}" no está apuntado en esa sesión`);
      all.sessions[s.id] = sessionFrom(s.id, { sets: cur.sets.filter(x => x !== ex) }, cur); save(all);
      return { borrado: ex.ex, sesion: compact(sessions().find(x => x.id === s.id)) };
    }
    if (name === 'borrar_entreno') {
      const s = find(a.id), all = load();
      if (!all.sessions[s.id]) return { nada_que_borrar: s.id };
      delete all.sessions[s.id]; save(all);
      return s.manual ? { borrada: `${s.tipo} del ${s.fecha}` } : { borrado_lo_apuntado: `${s.garmin} del ${s.fecha}`, nota: 'La actividad de Garmin sigue ahí, sin valorar.' };
    }
    if (name === 'ver_progresion') {
      const set = st();
      if (a.ejercicio) return progression(exName(a.ejercicio, a.tipo, set), set);
      if (a.tipo) return { tipo: a.tipo, ejercicios: (plans(set)[a.tipo] || []).map(ex => progression(ex, set)) };
      throw new Error('di un ejercicio o un tipo de sesión');
    }
    if (name === 'ver_mis_ejercicios') {
      const set = st(), L = lib(set), seen = new Map(), P = new Set(Object.values(plans(set)).flat().map(L.canon));
      sessions().forEach(s => (s.ejercicios || []).forEach(x => { const c = L.canon(x.ex); seen.set(c, s.fecha); }));
      const one = n => { const e = L.L[n]; return { ejercicio: n, nota: e.desc || undefined, principales: e.main.map(k => EX.MUS_ES[k]), secundarios: e.sec.length ? e.sec.map(k => EX.MUS_ES[k]) : undefined,
        otros_nombres: e.alias.length ? e.alias : undefined, ultima_vez: seen.get(n), de_catalogo: e.bank && !seen.has(n) && !P.has(n) || undefined }; };
      if (a.ejercicio) { const c = L.canon(a.ejercicio); if (!L.L[c]) return { sin_definir: a.ejercicio, aviso: 'No está en «Mis ejercicios»: créalo con editar_ejercicio o di con es_el_mismo_que cuál es.' }; return one(c); }
      const mine = Object.keys(L.L).filter(n => a.catalogo || !L.L[n].bank || seen.has(n) || P.has(n));
      return { ejercicios: mine.map(one), sin_definir: [...seen.keys()].filter(n => !L.L[n]).concat(Object.keys(L.L).filter(n => (seen.has(n) || P.has(n)) && !L.L[n].main.length && !L.L[n].sec.length)),
        musculos: Object.fromEntries(MUSCLES.map(k => [k, EX.MUS_ES[k]])) };
    }
    if (name === 'editar_ejercicio') {
      const all = load(), set = all.settings, L = lib(set), X = { ...(set.exercises || {}) }, cur = L.L[L.canon(a.nombre)], nombre = cur ? L.canon(a.nombre) : String(a.nombre || '').trim().slice(0, 60);
      if (!nombre) throw new Error('falta el nombre');
      const bad = [...(a.principales || []), ...(a.secundarios || [])].filter(m => !MUSCLES.includes(m)); if (bad.length) throw new Error(`músculos no válidos: ${bad.join(', ')}; usa: ${MUSCLES.join(', ')}`);
      const b = {};
      if (a.es_el_mismo_que) { const t = L.canon(a.es_el_mismo_que), e = L.L[t]; if (!e) throw new Error(`«${a.es_el_mismo_que}» no está en «Mis ejercicios»`);
        X[t] = { desc: e.desc, main: e.main, sec: e.sec, alias: [...new Set([...e.alias, String(a.nombre).trim()])] }; b.exercises = X;
        all.settings = settingsFrom(b, set); save(all); return { hecho: `«${a.nombre}» es ${t}`, ejercicio: call('ver_mis_ejercicios', { ejercicio: t }) }; }
      const e = cur || { desc: '', main: [], sec: [], alias: [] }, nuevo = a.nuevo_nombre != null ? String(a.nuevo_nombre).trim().slice(0, 60) : nombre;
      if (!nuevo) throw new Error('nuevo_nombre vacío');
      if (nuevo !== nombre && L.L[nuevo]) throw new Error(`ya existe un ejercicio llamado «${nuevo}»`);
      let alias = [...e.alias, ...(a.otros_nombres_anadir || []).map(x => String(x).trim()).filter(Boolean)];
      const quitar = new Set((a.otros_nombres_quitar || []).map(norm)); alias = alias.filter(x => !quitar.has(norm(x)));
      if (nuevo !== nombre && cur) { alias.push(nombre); if (EX.DEF_EX[nombre] || EX.BANK_EX[nombre]) X[nombre] = { hide: true }; else delete X[nombre];
        const pl = set.plans || {}, np = {}; for (const [k, v] of Object.entries(pl)) if (v.includes(nombre)) np[k] = v.map(x => x === nombre ? nuevo : x); if (Object.keys(np).length) b.plans = { ...pl, ...np }; }
      X[nuevo] = { desc: a.nota !== undefined ? String(a.nota) : e.desc, main: a.principales || e.main, sec: a.secundarios || e.sec, alias: [...new Set(alias)].filter(x => norm(x) !== norm(nuevo)) };
      b.exercises = X; all.settings = settingsFrom(b, set); save(all);
      return { guardado: call('ver_mis_ejercicios', { ejercicio: nuevo }) };
    }
    if (name === 'ver_ajustes_entreno') {
      const set = st(), g = { sleep_h: 7, steps: 8000, im: 150, strength: 2, bedtime: '23:30', ...(set.goals || {}) }, R = rule(set);
      return { regla: { reps: R.top, sube_kg: R.inc }, planes: plans(set), objetivos: { sueno_h: g.sleep_h, pasos: g.steps, min_intensidad: g.im, sesiones_fuerza: g.strength, acostarse: g.bedtime } };
    }
    if (name === 'cambiar_ajustes_entreno') {
      const all = load(), set = all.settings, b = {};
      if (a.regla) { const R = rule(set); b.rule = { top: a.regla.reps ?? R.top, inc: a.regla.sube_kg ?? R.inc }; }
      if (a.planes) { const bad = Object.keys(a.planes).filter(k => !KINDS.includes(k)); if (bad.length) throw new Error(`tipos no válidos: ${bad.join(', ')}`); b.plans = { ...plans(set), ...a.planes }; }
      if (a.objetivos) { const o = a.objetivos, g = { sleep_h: 7, steps: 8000, im: 150, strength: 2, bedtime: '23:30', ...(set.goals || {}) };
        if (o.acostarse != null && !/^\d{2}:\d{2}$/.test(o.acostarse)) throw new Error('acostarse en HH:MM');
        b.goals = { sleep_h: o.sueno_h ?? g.sleep_h, steps: o.pasos ?? g.steps, im: o.min_intensidad ?? g.im, strength: o.sesiones_fuerza ?? g.strength, bedtime: o.acostarse ?? g.bedtime }; }
      if (!Object.keys(b).length) throw new Error('no hay nada que cambiar');
      all.settings = settingsFrom(b, set); save(all);
      return call('ver_ajustes_entreno', {});
    }
    throw new Error('herramienta desconocida');
  }
  return { TOOLS, has: n => TOOLS.some(t => t.name === n), call };
};
