// Herramientas de salud para el conector de Claude (/comida/mcp, el mismo token que las de comida y entreno). SOLO LECTURA.
// Fuentes en el servidor: data.json (el panel que genera la sincronización con Garmin: días, actividades, instantáneas…),
// log.json (hábitos, medidas, agua, «estoy mala»), mood.json (ánimo), config.json (nombres de hábitos), train.json (objetivos),
// food_goals.json (objetivos de comida) y garmin/aviso_salud.json (aviso diario). Nunca escribe nada.
'use strict';
const path = require('path');

module.exports = function saludMcp({ DATA_DIR, LOG_FILE, FGOALS, DEFAULT_GOALS, readJson }) {
  const F = n => path.join(DATA_DIR, n);
  const DATE = /^\d{4}-\d{2}-\d{2}$/, MAX_DAYS = 365;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
  const mon = d => addDays(d, -((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const r = (v, n = 0) => v == null || !Number.isFinite(+v) ? null : Math.round(v * 10 ** n) / 10 ** n;
  const mean = a => { const v = a.filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const hm = h => h == null ? null : `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, '0')} min`;
  const clean = o => JSON.parse(JSON.stringify(o, (k, v) => (v === null || v === undefined || (Array.isArray(v) && !v.length)) ? undefined : v));
  const fecha = (v, def) => { if (v == null || v === '') return def; const s = String(v).trim().toLowerCase();
    if (s === 'hoy') return today(); if (s === 'ayer') return addDays(today(), -1);
    if (!DATE.test(s)) throw new Error('fecha en formato AAAA-MM-DD (o "hoy", "ayer")'); return s; };

  const data = () => readJson(F('data.json'), {}) || {};
  const dayOf = (D, d) => (D.days || []).find(x => x.date === d) || null;
  const log = () => Object.values(readJson(LOG_FILE, {}) || {});
  const logVal = (L, d, kind, key) => { const e = L.find(x => x.date === d && x.kind === kind && x.key === key); return e ? e.value : null; };
  const settings = () => (readJson(F('train.json'), {}) || {}).settings || {};
  function goals(D) {
    const st = settings(), g = { sleep_h: 7, steps: 10000, im: 150, strength: 2, bedtime: '23:30', ...(st.goals || {}) };
    if (!(st.goals && st.goals.steps) && D.step_goal) g.steps = D.step_goal;
    const fg = { ...(DEFAULT_GOALS || {}), ...(readJson(FGOALS, {}) || {}) }, t = today();
    const vals = (D.days || []).filter(x => x.date < t && x.kcal_total > 800).slice(-7).map(x => x.kcal_total);
    let kcal = fg.mode === 'garmin' && vals.length ? mean(vals) + (fg.adjust || 0) : fg.kcal; kcal = Math.round((kcal || 0) / 10) * 10 || null;
    const wd = (D.days || []).slice().reverse().find(x => x.weight_7d || x.weight), w = wd ? wd.weight_7d || wd.weight : fg.weight || null;
    return { pasos_dia: g.steps, sueno_h: g.sleep_h, acostarse: g.bedtime, min_intensidad_semana: g.im, sesiones_fuerza_semana: g.strength,
      kcal_comidas_dia: kcal, kcal_segun: fg.mode === 'garmin' && vals.length ? `gasto medio de Garmin de ${vals.length} días${fg.adjust ? ` ${fg.adjust > 0 ? '+' : ''}${fg.adjust}` : ''}` : 'fijo',
      proteina_g_kg: fg.protein_gkg, proteina_g_dia: w && fg.protein_gkg ? Math.round(w * fg.protein_gkg) : null, grasa_pct_kcal: fg.fat_pct, agua_l_dia: fg.water_l || 2 };
  }
  const lastSync = D => { const c = readJson(path.join(DATA_DIR, 'garmin', 'cloud_sync.json'), null);
    return { panel_generado: D.generated_at || null, ultima_sincronizacion: (c && (c.last_end || c.last_start)) || null }; };

  // --- Métricas para tendencias ---
  const MET = {
    pasos: ['steps', 'pasos', 0], sueno: ['sleep_h', 'h', 2], puntuacion_sueno: ['sleep_score', '', 0], vfc: ['hrv_night', 'ms', 0], pulso_reposo: ['rhr', 'lpm', 0],
    estres: ['stress_avg', '', 0], body_battery: ['bb_wake', '', 0], respiracion: ['resp_sleep', 'rpm', 1], spo2: ['spo2_avg', '%', 0], peso: ['weight', 'kg', 1],
    kcal_gastadas: ['kcal_total', 'kcal', 0], kcal_activas: ['kcal_active', 'kcal', 0], kcal_comidas: ['kcal_in', 'kcal', 0], proteina: ['protein_in', 'g', 0],
    minutos_intensidad: [d => d.im_moderate == null && d.im_vigorous == null ? null : (d.im_moderate || 0) + 2 * (d.im_vigorous || 0), 'min', 0],
    carga_entreno: [d => { const m = srpeByDay(); return Math.round(m[d.date] || 0); }, 'sRPE', 0], animo: ['mood', '1-5', 1], energia: ['energy', '1-5', 1], vo2max: ['vo2max', '', 1],
  };
  const getM = (d, key) => typeof key === 'function' ? key(d) : d[key] ?? null;
  // Carga de entreno (sRPE = RPE × minutos) por día. El RPE lo pones en la app (train.json, por id de actividad),
  // no en Garmin, así que el srpe de data.json sale 0: se calcula aquí con la duración de cada actividad.
  function srpeByDay() {
    const D = data(), T = (readJson(F('train.json'), {}) || {}).sessions || {}, out = {}, seen = new Set();
    for (const a of D.activities || []) { const s = T[String(a.id)] || {}, rpe = s.rpe ?? a.rpe, min = a.duration_s ? a.duration_s / 60 : a.minutes; seen.add(String(a.id));
      if (rpe && min) out[a.date] = (out[a.date] || 0) + rpe * min; }
    for (const s of Object.values(T)) if (s.manual && !seen.has(s.id) && s.rpe && s.minutes && s.date) out[s.date] = (out[s.date] || 0) + s.rpe * s.minutes;
    return out;
  }

  function saludDia(a) {
    const D = data(), t = today(), d = fecha(a.fecha, t), x = dayOf(D, d), L = log(), g = goals(D);
    const agua = logVal(L, d, 'metric', 'agua');
    const out = { fecha: d, ...lastSync(D) };
    if (!x) { out.aviso = d === t ? 'Aún no han llegado los datos de Garmin de hoy (el reloj tiene que sincronizar con el móvil y luego el servidor los trae cada 30 min).' : 'No hay datos de Garmin para ese día.';
      if (agua != null) out.agua = { litros: agua, objetivo_l: g.agua_l_dia, cumplido: agua >= g.agua_l_dia }; return clean(out); }
    const im = (x.im_moderate || 0) + 2 * (x.im_vigorous || 0);
    // movimiento: duración de todas las actividades + minutos de intensidad de Garmin fuera de ellas (sin contarlos dos veces)
    const A = (D.activities || []).filter(a => a.date === d), actMin = A.reduce((t2, a) => t2 + (a.duration_s ? a.duration_s / 60 : a.minutes || 0), 0);
    const outIm = Math.max(0, (x.im_moderate || 0) + (x.im_vigorous || 0) - A.reduce((t2, a) => t2 + (a.im_moderate || 0) + (a.im_vigorous || 0), 0));
    const sinPasos = A.filter(a => /cycl|bik|swim/.test(String(a.type_key || ''))).reduce((t2, a) => t2 + (a.duration_s || 0) / 60, 0);
    const mg = ((settings().goals || {}).move_goal_min) || 45, mon0 = mon(d);
    const imSem = (D.days || []).filter(y => y.date >= mon0 && y.date <= d).reduce((t2, y) => t2 + (y.im_moderate || 0) + 2 * (y.im_vigorous || 0), 0);
    Object.assign(out, {
      datos_actualizados: x.updated_at || null,
      pasos: x.steps != null ? { pasos: x.steps, objetivo: g.pasos_dia, cumplido: x.steps >= g.pasos_dia, faltan: Math.max(0, g.pasos_dia - x.steps), objetivo_garmin_ese_dia: x.step_goal } : null,
      kcal: { gastadas_total: x.kcal_total, activas: x.kcal_active, comidas: x.kcal_in, proteina_g: x.protein_in },
      sueno: x.sleep_h != null ? { duracion: hm(x.sleep_h), horas: r(x.sleep_h, 2), puntuacion: x.sleep_score, de: (x.sleep_start || '').slice(11, 16) || null, a: (x.sleep_end || '').slice(11, 16) || null,
        profundo: x.deep_s != null ? hm(x.deep_s / 3600) : null, ligero: x.light_s != null ? hm(x.light_s / 3600) : null, rem: x.rem_s != null ? hm(x.rem_s / 3600) : null,
        despierta: x.awake_s != null ? hm(x.awake_s / 3600) : null, objetivo_h: g.sueno_h, cumplido: x.sleep_h >= g.sueno_h, noche: `del ${addDays(d, -1)} al ${d}` } : null,
      body_battery: { al_despertar: x.bb_wake, maximo: x.bb_high, minimo: x.bb_low, cargo: x.bb_charged, gasto: x.bb_drained },
      vfc: x.hrv_night != null ? { nocturna_ms: x.hrv_night, media_7d: x.hrv_7d, rango_normal: x.hrv_base_low != null ? `${r(x.hrv_base_low)}-${r(x.hrv_base_high)}` : null, estado_garmin: x.hrv_status !== 'NONE' ? x.hrv_status : null } : null,
      pulso_reposo: x.rhr != null ? { lpm: x.rhr, tu_media: r(x.rhr_base) } : null,
      estres_medio: x.stress_avg, respiracion_rpm: x.resp_sleep, spo2_media: x.spo2_avg,
      minutos_intensidad: x.im_moderate != null || x.im_vigorous != null ? { total: im, moderados: x.im_moderate, intensos: x.im_vigorous, semana: imSem, meta_semana_oms: g.min_intensidad_semana } : null,
      movimiento: { minutos: Math.round(actMin + outIm), meta: mg, cumplido: actMin + outIm >= mg, en_actividades: Math.round(actMin), fuera_de_actividades: outIm,
        sin_pasos_min: sinPasos ? Math.round(sinPasos) : null, nota: sinPasos ? 'La bici y la natación no suman pasos, pero sí movimiento.' : null,
        actividades: A.map(a => `${String(a.start_local || '').slice(11, 16)} ${a.name || a.type_key} ${Math.round((a.duration_s || 0) / 60)} min`) },
      agua: agua != null ? { litros: agua, objetivo_l: g.agua_l_dia, cumplido: agua >= g.agua_l_dia } : { litros: 0, objetivo_l: g.agua_l_dia, nota: 'sin apuntar' },
      peso: x.weight != null || x.weight_7d != null ? { kg: x.weight, media_7d: r(x.weight_7d, 1) } : null,
      preparacion_garmin: x.readiness, carga_entreno: Math.round(srpeByDay()[d] || 0) || null, fase_ciclo: x.phase, dia_ciclo: x.cycle_day,
    });
    if (d === t) out.nota = `Día en curso: pasos, kcal y minutos son hasta la última sincronización${x.updated_at ? ` (${String(x.updated_at).slice(11, 16)})` : ''} y seguirán subiendo.`;
    return clean(out);
  }
  function tendencia(a) {
    const m = MET[String(a.metrica || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_')];
    if (!m) throw new Error(`métrica no válida; usa una de: ${Object.keys(MET).join(', ')}`);
    const n = Math.max(7, Math.min(90, Math.round(+a.dias || 30))), D = data(), t = today(), from = addDays(t, -n + 1);
    const serie = []; for (let i = 0; i < n; i++) { const d = addDays(from, i), x = dayOf(D, d); serie.push([d, x ? r(getM(x, m[0]), m[2]) : null]); }
    // los acumulados del día (pasos, kcal, minutos, carga) de hoy aún no están completos: no entran en las medias
    const partial = ['steps', 'kcal_total', 'kcal_active', 'kcal_in', 'protein_in', 'srpe'].includes(m[0]) || typeof m[0] === 'function';
    const stats = partial ? serie.filter(s => s[0] !== t) : serie;
    const v = stats.map(s => s[1]).filter(x => x != null);
    const lastW = stats.slice(-7).map(s => s[1]).filter(x => x != null), prevW = [];
    for (let i = 7; i < 14; i++) { const d = addDays(t, -i), x = dayOf(D, d); if (x) prevW.push(getM(x, m[0])); }
    const base = (D.days || []).filter(x => x.date < from).slice(-28).map(x => getM(x, m[0])).filter(x => x != null);
    const L = (D.days || []).slice().reverse().find(x => getM(x, m[0]) != null);
    return clean({ metrica: a.metrica, unidad: m[1], dias: n, desde: from, hasta: t, dias_con_dato: v.length,
      media: r(mean(v), m[2] + 1), minimo: v.length ? Math.min(...v) : null, maximo: v.length ? Math.max(...v) : null,
      media_ultimos_7: r(mean(lastW), m[2] + 1), media_7_anteriores: r(mean(prevW.filter(x => x != null)), m[2] + 1),
      linea_base: m[0] === 'hrv_night' && L && L.hrv_base_low != null ? `rango normal ${r(L.hrv_base_low)}-${r(L.hrv_base_high)} ms` : m[0] === 'rhr' && L && L.rhr_base != null ? `media ${r(L.rhr_base, 1)} lpm`
        : base.length >= 7 ? `media de los ${base.length} días anteriores: ${r(mean(base), m[2] + 1)}` : 'aún no hay bastantes días anteriores',
      serie: serie.filter(s => s[1] != null).map(s => `${s[0]}: ${s[1]}${partial && s[0] === t ? ' (hoy, en curso)' : ''}`),
      hoy_fuera_de_medias: partial ? 'el día de hoy no cuenta en las medias porque aún no ha terminado' : null,
      nota: (D.days || []).length && (D.days[0].date > from) ? `Los datos empiezan el ${D.days[0].date} (cuando llegó el reloj).` : null });
  }
  // Regularidad del sueño: hora de acostarse (minutos desde las 18:00) y de levantarse en las noches del rango
  const sdv = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) : null; };
  const hhmm = m => { const t = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  function regularidad(W) {
    const R = W.filter(x => x.sleep_start && x.sleep_end); if (R.length < 3) return null;
    const cm = iso => { const m = +iso.slice(11, 13) * 60 + +iso.slice(14, 16); return m < 1080 ? m + 360 : m - 1080; }, bed = R.map(x => cm(x.sleep_start)), wake = R.map(x => +x.sleep_end.slice(11, 13) * 60 + +x.sleep_end.slice(14, 16));
    const we = R.filter(x => [6, 0].includes(new Date(x.date + 'T12:00:00Z').getUTCDay())), wd = R.filter(x => ![6, 0].includes(new Date(x.date + 'T12:00:00Z').getUTCDay()));
    const hrs = R.map(x => x.sleep_h).filter(x => x != null), sb = sdv(bed);
    return { noches: R.length, se_acuesta: `${hhmm(Math.min(...bed) + 1080)} a ${hhmm(Math.max(...bed) + 1080)} (±${Math.round(sb)} min)`, se_levanta: `${hhmm(Math.min(...wake))} a ${hhmm(Math.max(...wake))} (±${Math.round(sdv(wake))} min)`,
      horas: hrs.length ? `${r(Math.min(...hrs), 1)} a ${r(Math.max(...hrs), 1)} h` : null, valoracion: sb <= 30 ? 'regular' : sb <= 60 ? 'algo irregular' : 'irregular',
      fin_de_semana: we.length && wd.length ? `${r((mean(we.map(x => cm(x.sleep_start))) - mean(wd.map(x => cm(x.sleep_start)))) / 60, 1)} h más tarde que entre semana` : null };
  }
  function semana(a) {
    const D = data(), t = today(), m0 = a && a.fecha ? mon(fecha(a.fecha, t)) : mon(t), end = addDays(m0, 6) < t ? addDays(m0, 6) : t, g = goals(D), L = log();
    const W = (D.days || []).filter(x => x.date >= m0 && x.date <= end);
    let ent = []; try { ent = require('./entreno_mcp')({ DATA_DIR, readJson, writeAtomic: () => { throw new Error('solo lectura'); } }).call('ver_entrenos', { desde: m0, hasta: end }).sesiones || []; } catch {}
    const STR = ['Push', 'Pull', 'Legs', 'Fuerza'], porTipo = {};
    ent.forEach(s => { const k = s.tipo || 'Sin tipo', b = porTipo[k] || (porTipo[k] = { sesiones: 0, minutos: 0 }); b.sesiones++; b.minutos += s.minutos || 0; });
    const steps = W.map(x => x.steps).filter(x => x != null), sleep = W.map(x => x.sleep_h).filter(x => x != null);
    const im = W.reduce((s, x) => s + (x.im_moderate || 0) + 2 * (x.im_vigorous || 0), 0);
    const agua = []; for (let d = m0; d <= end; d = addDays(d, 1)) { const v = logVal(L, d, 'metric', 'agua'); if (v != null) agua.push(v); }
    const wt = W.filter(x => x.weight != null || x.weight_7d != null);
    // cardio en zona 2+ (paseos, cinta, bici…) con las zonas de pulso de cada actividad, y series clave de fuerza
    const CARDIO = ['Caminar', 'Cinta', 'Bici', 'Correr', 'Natación', 'Pádel'], A = Object.fromEntries((D.activities || []).map(x => [String(x.id), x]));
    const z2 = Math.round(ent.filter(s => CARDIO.includes(s.tipo) && A[s.id]).reduce((t, s) => { const x = A[s.id]; return t + ((x.z2_s || 0) + (x.z3_s || 0) + (x.z4_s || 0) + (x.z5_s || 0)) / 60; }, 0));
    const tr = (readJson(F('train.json'), {}) || {}).sessions || {};
    const clave = Object.values(tr).filter(s => s.date >= m0 && s.date <= end).flatMap(s => (s.sets || []).filter(x => x.key).map(x => `${s.date} ${s.kind || ''}: ${x.ex} ${x.kg ?? '?'} kg × ${x.reps ?? '?'}`));
    const rpes = ent.map(s => s.rpe).filter(x => x != null);
    return clean({ semana: `${m0} a ${end}`,
      pasos: { media: r(mean(steps)), dias_con_objetivo: steps.filter(x => x >= g.pasos_dia).length, de: steps.length, objetivo: g.pasos_dia },
      sueno: { media: hm(mean(sleep)), noches_con_objetivo: sleep.filter(x => x >= g.sueno_h).length, de: sleep.length, objetivo_h: g.sueno_h, puntuacion_media: r(mean(W.map(x => x.sleep_score))) },
      entrenos_por_tipo: porTipo, sesiones_fuerza: { hechas: ent.filter(s => STR.includes(s.tipo) || s.fuerza === true).length, objetivo: g.sesiones_fuerza_semana },
      minutos_intensidad: { hechos: im, objetivo: g.min_intensidad_semana },
      cardio_zona2_o_mas_min: z2, minutos_fuerza: ent.filter(s => STR.includes(s.tipo) || s.fuerza === true).reduce((t, s) => t + (s.minutos || 0), 0),
      rpe_medio: r(mean(rpes), 1), series_clave: clave, regularidad_sueno: regularidad(W),
      vfc_media_ms: r(mean(W.map(x => x.hrv_night))), pulso_reposo_medio: r(mean(W.map(x => x.rhr)), 1), estres_medio: r(mean(W.map(x => x.stress_avg))),
      peso: wt.length ? { primero: r(wt[0].weight ?? wt[0].weight_7d, 1), ultimo: r(wt[wt.length - 1].weight ?? wt[wt.length - 1].weight_7d, 1) } : null,
      agua: agua.length ? { media_l: r(mean(agua), 2), dias_con_objetivo: agua.filter(x => x >= g.agua_l_dia).length, de: agua.length, objetivo_l: g.agua_l_dia } : null });
  }
  function aviso() {
    const A = readJson(path.join(DATA_DIR, 'garmin', 'aviso_salud.json'), null);
    if (!A) return { aviso: 'Aún no hay aviso de salud calculado (se calcula tras cada sincronización con Garmin).' };
    return clean({ hoy: A.hoy, historial: (A.historial || []).slice(-30) });
  }
  function diario(a) {
    const t = today(), d = fecha(a.fecha, t), L = log().filter(x => x.date === d), cfg = readJson(F('config.json'), null) || {};
    const lbl = Object.fromEntries([...(cfg.habits || []), ...(cfg.metrics || [])].map(h => [h.key, h.label]));
    const moods = (readJson(F('mood.json'), []) || []).filter(m => String(m.ts || '').slice(0, 10) === d)
      .map(m => clean({ hora: String(m.ts).slice(11, 16), animo: m.mood, energia: m.energy, nota: m.note || null }));
    const habits = L.filter(x => x.kind === 'habit' && x.key !== 'mala').map(x => `${lbl[x.key] || x.key}: ${x.value ? 'sí' : 'no'}`);
    const metrics = L.filter(x => x.kind === 'metric').map(x => `${lbl[x.key] || x.key}: ${x.value}${x.src === 'comida' ? ' (de Comida)' : ''}`);
    const mala = L.find(x => x.kind === 'habit' && x.key === 'mala'), niv = L.find(x => x.kind === 'sick' && x.key === 'nivel');
    const sint = L.filter(x => x.kind === 'sick' && x.key.startsWith('sint_') && x.value === 1).map(x => x.key.slice(5));
    return clean({ fecha: d, animo_y_energia: moods.length ? moods : 'sin registros (escala 1-5)', habitos: habits,
      estoy_mala: mala ? (mala.value ? { nivel: ['', 'leve', 'moderado', 'fuerte'][niv ? niv.value : 1] || 'sí', sintomas: sint, nota: niv && niv.note } : 'no') : 'sin apuntar',
      medidas: metrics, nada_apuntado: !L.length && !moods.length ? true : null });
  }
  // medias por fase de data.json, con la carga (srpe) recalculada desde el RPE de la app
  function fasesConCarga(D) {
    if (!D.phases) return null;
    const m = srpeByDay(), by = {};
    (D.days || []).forEach(x => { if (x.phase) (by[x.phase] = by[x.phase] || []).push(m[x.date] || 0); });
    return Object.fromEntries(Object.entries(D.phases).map(([k, v]) => [k, { ...v, srpe: by[k] && by[k].length ? r(mean(by[k]), 1) : v.srpe }]));
  }
  function ciclo() {
    const D = data(), t = today(), c = (D.days || []).slice().reverse().find(x => x.cycle_day != null);
    if (!c) return { ciclo: 'No hay datos del ciclo (se registra en Garmin Connect, Salud femenina).' };
    const len = c.cycle_len || 28, day = c.cycle_day + daysBetween(c.date, t), start = addDays(t, -day + 1), pl = c.period_len || 5;
    const fase = day <= pl ? 'menstrual' : day < len - 15 ? 'folicular' : day <= len - 13 ? 'ovulatoria' : 'lútea';
    return clean({ dia_del_ciclo: day, de: len, fase, inicio_regla: start, ovulacion_aprox: addDays(start, len - 14), proxima_regla_aprox: addDays(start, len),
      ultimo_dato_garmin: c.date, flujo: c.flow, sintomas_garmin: c.symptoms, medias_por_fase: fasesConCarga(D), nota: 'Fechas estimadas por Garmin.' });
  }
  function actividades(a) {
    const t = today(), hasta = fecha(a.hasta, t), desde = fecha(a.desde, addDays(hasta, -13));
    if (desde > hasta) throw new Error('"desde" es posterior a "hasta"');
    if (daysBetween(desde, hasta) > MAX_DAYS) throw new Error(`como mucho ${MAX_DAYS} días`);
    const ent = require('./entreno_mcp')({ DATA_DIR, readJson, writeAtomic: () => { throw new Error('solo lectura'); } }).call('ver_entrenos', { desde, hasta });
    return ent;
  }
  // Zonas de pulso (perfil de Garmin o, si aún no han llegado, 50/60/70/80/90 % de la FC máx), zona 2 y 3+ de la semana y VO2max
  function zonas(a) {
    const D = data(), t = today(), m0 = mon(a && a.fecha ? fecha(a.fecha, t) : t), end = addDays(m0, 6) < t ? addDays(m0, 6) : t, z = D.hr_zones;
    const max = (z && z.fc_max) || 195, f = z && Array.isArray(z.desde) && z.desde.every(x => x) ? z.desde : [.5, .6, .7, .8, .9].map(p => Math.round(max * p));
    const NOM = ['1 muy suave (recuperar)', '2 suave (base de resistencia; hablas con frases)', '3 moderada (ritmo sostenido)', '4 dura (sube el VO2max)', '5 máxima (sprints)'];
    let ent = []; try { ent = require('./entreno_mcp')({ DATA_DIR, readJson, writeAtomic: () => { throw new Error('solo lectura'); } }).call('ver_entrenos', { desde: m0, hasta: end }).sesiones || []; } catch {}
    const A = Object.fromEntries((D.activities || []).map(x => [String(x.id), x])), CARDIO = ['Caminar', 'Cinta', 'Bici', 'Correr', 'Natación', 'Pádel'];
    const z2 = Math.round(ent.filter(s => CARDIO.includes(s.tipo) && A[s.id]).reduce((t2, s) => t2 + (A[s.id].z2_s || 0) / 60, 0));
    const z3 = Math.round(ent.filter(s => A[s.id]).reduce((t2, s) => { const x = A[s.id]; return t2 + ((x.z3_s || 0) + (x.z4_s || 0) + (x.z5_s || 0)) / 60; }, 0));
    const goal = (settings().goals || {}).z2_goal_min || 90, vo = (D.days || []).slice().reverse().find(x => x.vo2max != null);
    return clean({ fc_max: max, origen: z && z.desde ? 'perfil de Garmin' : 'calculadas con la FC máxima (aún no han llegado las de Garmin)',
      zonas: f.map((x, i) => `Zona ${NOM[i]}: ${i < 4 ? `${x}-${f[i + 1] - 1}` : `${x}+`} ppm`),
      semana: `${m0} a ${end}`, zona2_cardio_min: z2, meta_zona2_min: goal, intenso_zona3_o_mas_min: z3,
      vo2max: vo ? { valor: vo.vo2max, fecha: vo.date, nota: 'Lo actualiza el reloj con caminatas o carreras al aire libre con GPS; mira la tendencia de 4-6 semanas.' } : null,
      consejo: 'Semana tipo: lun, mié y vie fuerza + 25-30 min de bici o cinta inclinada en zona 2; mar y jue funcional (intenso); sáb o dom caminata larga de 60 min con cuestas. +5 min por semana a cada sesión de zona 2, hasta 45.' });
  }
  function snapshots() {
    const S = data().health_snapshots;
    if (!Array.isArray(S) || !S.length) return { instantaneas: 'No hay ninguna Instantánea de salud todavía (prueba de 2 minutos en reposo desde el reloj).' };
    return { instantaneas: S.slice(-30).map(x => clean({ fecha: x.date, hora: x.time, fc: x.hr, vfc_ms: x.hrv, respiracion: x.resp, spo2: x.spo2, estres: x.stress })),
      nota: 'Para comparar, mejor hechas a la misma hora y en reposo.' };
  }

  const S = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
  const FECHA = { type: 'string', description: 'AAAA-MM-DD, "hoy" o "ayer"; por defecto hoy (hora de Madrid)' };
  const TOOLS = [
    { name: 'ver_salud_dia', description: 'Datos de salud de Magdalena de un día (por defecto hoy) de su reloj Garmin: pasos frente a su objetivo (¿ha andado bastante?), kcal gastadas, sueño (horas, fases, puntuación, a qué hora se durmió), Body Battery, VFC, pulso en reposo, estrés, respiración, SpO2, minutos de intensidad, agua frente a su objetivo, peso y cuándo se sincronizó. Úsala para cualquier pregunta sobre "hoy", "ayer" o un día concreto.',
      inputSchema: S({ fecha: FECHA }) },
    { name: 'ver_tendencia', description: `Evolución de una métrica día a día (7 a 90 días): serie, media, mínimo, máximo, últimos 7 frente a los 7 anteriores y su línea base. Métricas: ${Object.keys(MET).join(', ')}.`,
      inputSchema: S({ metrica: { type: 'string', enum: Object.keys(MET) }, dias: { type: 'number', minimum: 7, maximum: 90, description: 'por defecto 30' } }, ['metrica']) },
    { name: 'ver_resumen_semana', description: 'Resumen de la semana (lunes a hoy, o la semana de la fecha que pases): pasos, sueño y su regularidad (horas de acostarse y levantarse), entrenos por tipo, minutos de fuerza, cardio en zona 2 o más, RPE medio, series clave de fuerza, sesiones de fuerza frente a su objetivo, minutos de intensidad, VFC, pulso, estrés, peso y agua.',
      inputSchema: S({ fecha: { type: 'string', description: 'un día de la semana que quieras; por defecto esta semana' } }) },
    { name: 'ver_aviso_salud', description: 'El aviso de salud de hoy (si sus señales de la noche — pulso, VFC, respiración, estrés, recarga — se salen de lo normal y podría estar poniéndose mala), con nivel, señales e historial.', inputSchema: S({}) },
    { name: 'ver_diario', description: 'Lo que apuntó en el Diario de la app un día: ánimo y energía (1-5, con hora), hábitos (skincare, leer, alcohol, creatina…), si estaba mala (nivel, síntomas y nota) y medidas (peso, dolor, agua…).',
      inputSchema: S({ fecha: FECHA }) },
    { name: 'ver_objetivos', description: 'Todos sus objetivos: pasos al día, horas de sueño y hora de acostarse, minutos de intensidad y sesiones de fuerza a la semana, kcal, proteína, grasa y agua al día.', inputSchema: S({}) },
    { name: 'ver_ciclo', description: 'Ciclo menstrual: día del ciclo, fase, próxima regla y ovulación estimadas, y cómo cambian sus datos en cada fase.', inputSchema: S({}) },
    { name: 'ver_actividades', description: 'Actividades del reloj y sesiones a mano en un rango (por defecto 2 semanas, máximo 365 días): tipo, duración, pulso, kcal, RPE y ejercicios.',
      inputSchema: S({ desde: FECHA, hasta: FECHA }) },
    { name: 'ver_zonas', description: 'Zonas de pulso de Magdalena (en ppm, de su perfil de Garmin) y para qué sirve cada una, minutos en zona 2 y en zona 3 o más de la semana frente a su meta, su VO2max y la semana tipo recomendada para mejorar la resistencia.',
      inputSchema: S({ fecha: { type: 'string', description: 'un día de la semana que quieras; por defecto esta semana' } }) },
    { name: 'ver_health_snapshot', description: 'Sus Instantáneas de salud (la prueba de 2 minutos en reposo del reloj): pulso, VFC, respiración, SpO2 y estrés de cada una.', inputSchema: S({}) },
  ];
  const FN = { ver_salud_dia: saludDia, ver_tendencia: tendencia, ver_resumen_semana: semana, ver_aviso_salud: aviso, ver_diario: diario,
    ver_objetivos: () => ({ objetivos: goals(data()) }), ver_ciclo: ciclo, ver_actividades: actividades, ver_health_snapshot: snapshots, ver_zonas: zonas };
  return { TOOLS, has: n => !!FN[n], call: (n, a) => FN[n](a || {}) };
};
