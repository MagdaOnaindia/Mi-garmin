// Ejercicios de Entreno: músculos, «Mis ejercicios» de partida, catálogo y cómo se reconoce cada nombre.
// Lo usan la app (window.EX_DATA, cargado con <script src="/body-map.js">… y /exercises.js) y el conector de Claude (require).
(function (root, make) { if (typeof module === 'object' && module.exports) module.exports = make(); else root.EX_DATA = make(); })(this, function () {
'use strict';
  // Músculos: clave → [nombre, zona del dibujo de body-map.js]. El psoas no se ve en el dibujo: solo sale en la lista.
  const MUS = {pecho: ['Pecho', 'chest'], hombros: ['Hombros', 'deltoids'], biceps: ['Bíceps', 'biceps'], triceps: ['Tríceps', 'triceps'], antebrazo: ['Antebrazos', 'forearm'],
    abdomen: ['Abdomen', 'abs'], oblicuos: ['Oblicuos', 'obliques'], trapecio: ['Trapecio', 'trapezius'], dorsales: ['Dorsales y romboides', 'upper-back'], lumbar: ['Lumbar', 'lower-back'],
    gluteos: ['Glúteos', 'gluteal'], abductores: ['Glúteo medio', 'gluteal'], aductores: ['Aductores', 'adductors'], cuadriceps: ['Cuádriceps', 'quadriceps'], isquios: ['Isquios', 'hamstring'],
    gemelos: ['Gemelos', 'calves'], tibial: ['Tibial', 'tibialis'], psoas: ['Psoas', null]};
  const MUS_ES = Object.fromEntries(Object.entries(MUS).map(([k, v]) => [k, v[0]]));
  // Si un ejercicio no está en «Mis ejercicios»: por palabras del nombre o por la categoría de Garmin. Peso 1-3 por serie.
  const EX_MUS = [
    [/extension de cuadriceps|leg extension/, {cuadriceps: 3}],
    [/bulgara|split squat|zancada|lunge|step up/, {cuadriceps: 3, gluteos: 3, isquios: 1, aductores: 1}],
    [/sentadilla profunda/, {gluteos: 1, aductores: 1, psoas: 1}],
    [/sentadilla|squat|goblet|prensa/, {cuadriceps: 3, gluteos: 2, aductores: 1, isquios: 1}],
    [/peso muerto|rumano|deadlift/, {isquios: 3, gluteos: 2, lumbar: 2}],
    [/hip thrust|puente de gluteo|hip raise/, {gluteos: 3, isquios: 1}],
    [/abduccion|abductor|clamshell/, {abductores: 3}],
    [/curl femoral|leg curl/, {isquios: 3}],
    [/gemelo|calf|talones/, {gemelos: 3}],
    [/press banca|banca|bench|flexion|push up|aperturas|fly/, {pecho: 3, triceps: 2, hombros: 1}],
    [/press de hombro|press militar|shoulder press|arnold/, {hombros: 3, triceps: 1}],
    [/elevaciones|lateral raise|frontal/, {hombros: 3}],
    [/triceps|fondos|dip/, {triceps: 3}],
    [/jalon|dominada|pull up|pulldown/, {dorsales: 3, biceps: 2, trapecio: 1}],
    [/face pull/, {hombros: 2, trapecio: 2}],
    [/remo|row/, {dorsales: 3, trapecio: 2, biceps: 1}],
    [/biceps|curl/, {biceps: 3, antebrazo: 1}],
    [/extension lumbar|hiperextension|superman|bird dog/, {lumbar: 3, gluteos: 1}],
    [/plancha lateral/, {oblicuos: 3, abdomen: 1}],
    [/abdominal|crunch|curl-up|plancha|plank|dead bug|rueda|core/, {abdomen: 3, oblicuos: 1}],
    [/psoas/, {psoas: 3, abdomen: 1}],
    [/maleta|carry|granjero/, {oblicuos: 2, antebrazo: 2, trapecio: 1}],
    [/gato|camello|90\/90|reach|world|estiramiento|movilidad/, {lumbar: 1, psoas: 1, gluteos: 1}],
  ];
  const GX_MUS = {SQUAT: {cuadriceps: 3, gluteos: 2}, LUNGE: {cuadriceps: 3, gluteos: 3}, DEADLIFT: {isquios: 3, gluteos: 2, lumbar: 2}, HIP_RAISE: {gluteos: 3}, LEG_CURL: {isquios: 3},
    CALF_RAISE: {gemelos: 3}, BENCH_PRESS: {pecho: 3, triceps: 2}, PUSH_UP: {pecho: 3, triceps: 2}, FLYE: {pecho: 3}, SHOULDER_PRESS: {hombros: 3, triceps: 1}, LATERAL_RAISE: {hombros: 3},
    TRICEPS_EXTENSION: {triceps: 3}, PULL_UP: {dorsales: 3, biceps: 2}, ROW: {dorsales: 3, trapecio: 2, biceps: 1}, CURL: {biceps: 3}, HYPEREXTENSION: {lumbar: 3}, CRUNCH: {abdomen: 3},
    SIT_UP: {abdomen: 3}, PLANK: {abdomen: 3, oblicuos: 1}, CARRY: {oblicuos: 2, antebrazo: 2}, HIP_STABILITY: {abductores: 2, gluteos: 1}, SHRUG: {trapecio: 3}};
  // Si la sesión no tiene ejercicios (ni apuntados ni del reloj), los músculos típicos de su tipo (peso total por sesión)
  const KIND_MUS = {Push: {pecho: 6, hombros: 6, triceps: 6}, Pull: {dorsales: 8, trapecio: 4, biceps: 5, lumbar: 2}, Legs: {cuadriceps: 7, gluteos: 6, isquios: 4, gemelos: 2},
    Fuerza: {gluteos: 5, abdomen: 5, oblicuos: 4, psoas: 3, lumbar: 3, abductores: 3, cuadriceps: 2}, Movilidad: {psoas: 2, gluteos: 2, lumbar: 2, abdomen: 1},
    Funcional: {cuadriceps: 4, gluteos: 4, hombros: 3, abdomen: 3, pecho: 2, gemelos: 2}, 'Pádel': {cuadriceps: 2, gemelos: 2, hombros: 2, oblicuos: 2, antebrazo: 1}};
  // «Mis ejercicios» de partida: tus ejercicios de los planes con una nota y sus músculos (m principales, s secundarios).
  // a = otros nombres con los que llegan del reloj o de Connect. Lo que cambies tú se guarda en settings.exercises y manda.
  const DEF_EX = {
    'Sentadilla búlgara': {d: 'Pie de atrás en un banco; baja en vertical con la rodilla delantera sobre el pie.', m: ['cuadriceps', 'gluteos'], s: ['isquios', 'aductores']},
    'Extensión de cuádriceps': {d: 'En máquina, sentada: estira las rodillas y baja despacio.', m: ['cuadriceps']},
    'Step up': {d: 'Sube a un cajón con una pierna, sin impulsarte con la de abajo.', m: ['cuadriceps', 'gluteos'], s: ['isquios', 'gemelos']},
    'Peso muerto rumano en polea': {d: 'Cadera atrás con la espalda neutra; sube apretando glúteos.', m: ['isquios', 'gluteos'], s: ['lumbar'], a: ['Peso muerto']},
    'Goblet squat con talones elevados': {d: 'Sentadilla con la pesa en el pecho y los talones en una cuña.', m: ['cuadriceps'], s: ['gluteos', 'aductores', 'abdomen']},
    'Hip thrust a una pierna': {d: 'Espalda en el banco, un pie en el suelo; sube la cadera y aprieta.', m: ['gluteos'], s: ['isquios', 'abductores']},
    'Hip thrust con barra': {d: 'Espalda en el banco y barra en la cadera; sube hasta alinear y aprieta.', m: ['gluteos'], s: ['isquios']},
    'Press banca inclinado': {d: 'Banco inclinado: baja al pecho alto y empuja.', m: ['pecho'], s: ['hombros', 'triceps']},
    'Press militar': {d: 'Sentada, empuja las mancuernas por encima de la cabeza.', m: ['hombros'], s: ['triceps', 'trapecio'], a: ['Press de hombro sentada', 'Press de hombro']},
    'Tríceps en polea': {d: 'Codos pegados; estira hacia abajo y vuelve despacio.', m: ['triceps'], a: ['Extensión de tríceps']},
    'Elevaciones laterales y frontales': {d: 'Superserie: laterales hasta la altura del hombro y luego frontales.', m: ['hombros'], s: ['trapecio'], a: ['Superserie', 'Elevaciones laterales']},
    'Jalón al pecho': {d: 'Barra al pecho bajando los codos; sube controlando.', m: ['dorsales'], s: ['biceps', 'trapecio']},
    'Remo': {d: 'Tira hacia el ombligo juntando las escápulas.', m: ['dorsales', 'trapecio'], s: ['biceps', 'hombros']},
    'Face pull sentada': {d: 'Cuerda hacia la cara con los codos altos: hombro de atrás y espalda alta.', m: ['hombros', 'trapecio'], s: ['dorsales'], a: ['Face pull sentada en polea', 'Face pull']},
    'Curl de bíceps': {d: 'Codos quietos; sube sin balancear.', m: ['biceps'], s: ['antebrazo'], a: ['Bíceps']},
    'Extensión lumbar': {d: 'En el banco de hiperextensión: sube hasta alinear, sin arquear de más.', m: ['lumbar'], s: ['gluteos', 'isquios']},
    'Abdominales (opcional)': {d: 'Crunch controlado, sin tirar del cuello.', m: ['abdomen'], s: ['oblicuos'], a: ['Abdominales']},
    'Curl-up modificado (McGill)': {d: 'Una rodilla doblada, manos bajo la lumbar; despega solo los hombros.', m: ['abdomen'], s: ['oblicuos'], a: ['Curl-up McGill']},
    'Plancha lateral': {d: 'Apoyo en el antebrazo, cadera arriba y alineada.', m: ['oblicuos'], s: ['abdomen', 'abductores']},
    'Abducción tumbada de lado': {d: 'Tumbada de lado, sube la pierna de arriba un poco hacia atrás.', m: ['abductores']},
    'Psoas march boca arriba': {d: 'Boca arriba, lleva una rodilla al pecho contra resistencia, alternando.', m: ['psoas'], s: ['abdomen']},
    'Dead bug': {d: 'Lumbar pegada al suelo; estira brazo y pierna contrarios.', m: ['abdomen'], s: ['psoas', 'oblicuos']},
    'Plancha con toques de hombro': {d: 'En plancha alta, toca el hombro contrario sin mover la cadera.', m: ['abdomen', 'oblicuos'], s: ['hombros']},
    'Split squat con mancuernas': {d: 'Zancada estática: baja en vertical y sube.', m: ['cuadriceps', 'gluteos'], s: ['aductores', 'isquios']},
    'Paseo de maleta': {d: 'Camina con una pesa en una mano sin inclinarte.', m: ['oblicuos'], s: ['antebrazo', 'trapecio', 'abdomen']},
    'Bird dog': {d: 'A cuatro patas, estira brazo y pierna contrarios sin girar la cadera.', m: ['lumbar', 'gluteos'], s: ['abdomen', 'hombros']},
    'Puente de glúteo': {d: 'Boca arriba, sube la cadera apretando glúteos; pausa arriba.', m: ['gluteos'], s: ['isquios']},
    'Gato-camello': {d: 'A cuatro patas, redondea y arquea la espalda despacio.', m: ['lumbar'], s: ['abdomen']},
    'Reach and thread': {d: 'A cuatro patas, pasa un brazo por debajo y luego ábrelo al techo.', m: ['dorsales'], s: ['oblicuos', 'hombros']},
    '90/90 con cambio de lado': {d: 'Sentada con las piernas en 90/90; gira las rodillas de un lado al otro.', m: ['gluteos'], s: ['abductores', 'aductores', 'psoas']},
    'Zancada arrodillada con balanceo': {d: 'Rodilla atrás en el suelo; lleva la cadera adelante para estirar el psoas.', m: ['psoas'], s: ['cuadriceps', 'gluteos']},
    "World's greatest stretch": {d: 'Zancada, codo al suelo y gira el brazo al techo.', m: ['psoas', 'isquios'], s: ['gluteos', 'dorsales']},
    'Sentadilla profunda asistida': {d: 'Agarrada a algo, baja a sentadilla profunda y quédate.', m: ['aductores'], s: ['gluteos', 'psoas']},
    'Estiramiento de psoas': {d: 'Rodilla atrás en el suelo, glúteo apretado, cadera adelante.', m: ['psoas'], s: ['cuadriceps']},
    'Paloma': {d: 'Una pierna doblada delante y la otra estirada atrás.', m: ['gluteos'], s: ['abductores']},
    'Postura del niño': {d: 'De rodillas, sentada sobre los talones y brazos estirados delante.', m: ['lumbar'], s: ['dorsales']},
  };
  // Catálogo: ejercicios habituales (gimnasio, funcional, tabata) y los nombres genéricos de Garmin. Sirve para reconocer
  // lo que llega del reloj y para añadir ejercicios; en «Mis ejercicios» solo salen los que has hecho o añadido.
  const BANK_EX = {
    'Sentadilla': {d: 'Con barra, mancuernas o sin peso; baja con la espalda neutra.', m: ['cuadriceps', 'gluteos'], s: ['aductores', 'isquios', 'lumbar'], a: ['Sentadilla con barra', 'Squat']},
    'Sentadilla con salto': {d: 'Sentadilla y salto explosivo; cae suave.', m: ['cuadriceps', 'gluteos'], s: ['gemelos', 'isquios'], a: ['Jump squat']},
    'Zancada': {d: 'Paso largo y baja hasta casi tocar con la rodilla de atrás; alterna.', m: ['cuadriceps', 'gluteos'], s: ['isquios', 'aductores'], a: ['Zancadas', 'Lunge', 'Zancada alterna']},
    'Zancada con salto': {d: 'Zancadas cambiando de pierna en el aire.', m: ['cuadriceps', 'gluteos'], s: ['gemelos', 'isquios']},
    'Prensa de piernas': {d: 'En máquina: baja hasta 90° sin despegar la lumbar.', m: ['cuadriceps', 'gluteos'], s: ['isquios', 'aductores'], a: ['Prensa']},
    'Peso muerto': {d: 'Barra pegada a las piernas; empuja el suelo y extiende la cadera.', m: ['isquios', 'gluteos', 'lumbar'], s: ['trapecio', 'antebrazo', 'cuadriceps'], a: ['Deadlift']},
    'Curl femoral': {d: 'En máquina, tumbada o sentada: lleva los talones hacia el glúteo.', m: ['isquios'], s: ['gemelos']},
    'Elevación de talones': {d: 'Sube de puntillas y baja despacio.', m: ['gemelos'], a: ['Gemelos', 'Elevación de gemelos']},
    'Abducción en máquina': {d: 'Sentada, abre las piernas contra la máquina.', m: ['abductores'], s: ['gluteos']},
    'Aducción en máquina': {d: 'Sentada, cierra las piernas contra la máquina.', m: ['aductores']},
    'Patada de glúteo': {d: 'En polea o a cuatro patas: lleva la pierna atrás apretando el glúteo.', m: ['gluteos'], s: ['isquios'], a: ['Patada de glúteo en polea']},
    'Puente de glúteo con banda': {d: 'Puente con una banda en las rodillas, empujando hacia fuera.', m: ['gluteos', 'abductores'], s: ['isquios']},
    'Press banca': {d: 'Tumbada, baja la barra al pecho y empuja.', m: ['pecho'], s: ['triceps', 'hombros'], a: ['Press de banca', 'Bench press']},
    'Flexiones': {d: 'Cuerpo recto, pecho al suelo y empuja; con rodillas apoyadas si hace falta.', m: ['pecho', 'triceps'], s: ['hombros', 'abdomen'], a: ['Flexión', 'Push up']},
    'Aperturas': {d: 'Con mancuernas o polea: abre los brazos en arco y ciérralos.', m: ['pecho'], s: ['hombros']},
    'Fondos': {d: 'En banco o paralelas: baja doblando codos y sube.', m: ['triceps'], s: ['pecho', 'hombros']},
    'Press de hombro': {d: 'Empuja por encima de la cabeza.', m: ['hombros'], s: ['triceps', 'trapecio'], a: ['Press Arnold']},
    'Elevaciones laterales': {d: 'Brazos a los lados hasta la altura del hombro.', m: ['hombros'], s: ['trapecio']},
    'Pájaros': {d: 'Inclinada adelante, abre los brazos: hombro de atrás.', m: ['hombros'], s: ['trapecio', 'dorsales'], a: ['Deltoide posterior']},
    'Encogimientos': {d: 'Con peso en las manos, sube los hombros hacia las orejas.', m: ['trapecio'], a: ['Encogimiento de hombros']},
    'Dominadas': {d: 'Colgada, sube hasta pasar la barbilla; con banda si hace falta.', m: ['dorsales', 'biceps'], s: ['trapecio', 'antebrazo'], a: ['Jalón / dominadas', 'Dominada asistida']},
    'Remo con mancuerna': {d: 'Apoyada en el banco, tira de la mancuerna hacia la cadera.', m: ['dorsales'], s: ['trapecio', 'biceps', 'hombros']},
    'Remo en TRX': {d: 'Colgada de las cintas, cuerpo recto: tira del pecho hacia las manos.', m: ['dorsales', 'trapecio'], s: ['biceps', 'abdomen']},
    'Curl martillo': {d: 'Curl con las palmas mirándose.', m: ['biceps', 'antebrazo']},
    'Extensión de tríceps': {d: 'Por encima de la cabeza o en polea: estira los codos.', m: ['triceps']},
    'Plancha': {d: 'Antebrazos y puntas de los pies, cuerpo recto.', m: ['abdomen'], s: ['oblicuos', 'hombros', 'gluteos'], a: ['Plancha frontal']},
    'Russian twist': {d: 'Sentada, pies en el aire si puedes, gira el tronco de lado a lado.', m: ['oblicuos'], s: ['abdomen', 'psoas'], a: ['Giros rusos']},
    'Elevación de piernas': {d: 'Tumbada o colgada, sube las piernas sin arquear la lumbar.', m: ['abdomen', 'psoas'], s: ['oblicuos']},
    'Bicicleta abdominal': {d: 'Codo a la rodilla contraria, alternando.', m: ['oblicuos', 'abdomen'], s: ['psoas']},
    'Leñador': {d: 'Con polea o pesa, diagonal de arriba abajo girando el tronco.', m: ['oblicuos'], s: ['abdomen', 'hombros'], a: ['Woodchop']},
    'Superman': {d: 'Boca abajo, sube brazos y piernas a la vez.', m: ['lumbar'], s: ['gluteos', 'trapecio']},
    'Burpees': {d: 'Sentadilla, manos al suelo, plancha, vuelve y salta.', m: ['cuadriceps', 'pecho'], s: ['gluteos', 'hombros', 'triceps', 'abdomen', 'gemelos'], a: ['Burpee']},
    'Mountain climbers': {d: 'En plancha alta, lleva las rodillas al pecho alternando rápido.', m: ['abdomen'], s: ['hombros', 'psoas', 'cuadriceps'], a: ['Escaladores']},
    'Jumping jacks': {d: 'Saltos abriendo y cerrando brazos y piernas.', m: ['gemelos'], s: ['hombros', 'abductores', 'cuadriceps'], a: ['Saltos de tijera']},
    'Swing con kettlebell': {d: 'Bisagra de cadera: la pesa sube por el empuje del glúteo.', m: ['gluteos', 'isquios'], s: ['lumbar', 'hombros', 'abdomen'], a: ['Kettlebell swing']},
    'Thruster': {d: 'Sentadilla frontal y, al subir, press por encima de la cabeza.', m: ['cuadriceps', 'hombros'], s: ['gluteos', 'triceps', 'abdomen']},
    'Wall ball': {d: 'Sentadilla y lanza el balón a la pared; recógelo bajando.', m: ['cuadriceps', 'hombros'], s: ['gluteos', 'triceps']},
    'Step con salto': {d: 'Sube al cajón con salto o rápido alternando.', m: ['cuadriceps', 'gluteos'], s: ['gemelos'], a: ['Box jump', 'Salto al cajón']},
    'Comba': {d: 'Saltos pequeños y rápidos con la cuerda.', m: ['gemelos'], s: ['hombros', 'antebrazo'], a: ['Saltar a la comba']},
    'Pliometría': {d: 'Saltos explosivos (genérico del reloj).', m: ['cuadriceps', 'gemelos'], s: ['gluteos', 'isquios']},
    'Cuerpo completo': {d: 'Ejercicio de cuerpo entero (genérico del reloj); si sabes cuál fue, elígelo.', m: ['cuadriceps', 'gluteos', 'hombros'], s: ['abdomen', 'pecho', 'dorsales']},
    'Calentamiento': {d: 'Movilidad y activación (genérico del reloj).', m: [], s: ['cuadriceps', 'gluteos', 'hombros']},
    'Paseo con peso': {d: 'Camina con pesas en las manos (genérico del reloj).', m: ['antebrazo', 'trapecio'], s: ['oblicuos', 'abdomen']},
    'Estabilidad de cadera': {d: 'Ejercicio de cadera (genérico del reloj).', m: ['abductores'], s: ['gluteos']},
    'Ejercicio con banda': {d: 'Con banda elástica (genérico del reloj).', m: [], s: ['gluteos', 'hombros']},
  };

  const nrm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  // Biblioteca: catálogo + tus ejercicios de partida + lo que has cambiado tú (user = settings.exercises; hide: quitar uno de partida)
  function library(user) {
    const o = {};
    for (const [n, e] of Object.entries(BANK_EX)) o[n] = { desc: e.d || '', main: e.m || [], sec: e.s || [], alias: e.a || [], def: true, bank: true };
    for (const [n, e] of Object.entries(DEF_EX)) o[n] = { desc: e.d || '', main: e.m || [], sec: e.s || [], alias: e.a || [], def: true };
    for (const [n, e] of Object.entries(user || {})) { if (!e) continue; if (e.hide) { delete o[n]; continue; }
      o[n] = { desc: e.desc || '', main: e.main || [], sec: e.sec || [], alias: e.alias || [], def: !!(DEF_EX[n] || BANK_EX[n]) }; }
    const idx = new Map(); for (const n of Object.keys(o)) idx.set(nrm(n), n);
    for (const [n, e] of Object.entries(o)) e.alias.forEach(a => { if (!idx.has(nrm(a))) idx.set(nrm(a), n); });
    // nombre de la biblioteca para cualquier nombre (del reloj, de Connect, antiguo…); «Gato-camello, lento» → «Gato-camello»
    const canon = name => { const r = nrm(name); if (!r) return name; if (idx.has(r)) return idx.get(r);
      let best = null; for (const [k, v] of idx) if (k.length >= 4 && r.startsWith(k) && /^[\s,.:;(\-]/.test(r.slice(k.length)) && (!best || k.length > best[0].length)) best = [k, v];
      return best ? best[1] : name; };
    const info = name => o[canon(name)] || null;
    // músculos con peso por serie: principal 3, secundario 1; si no está en la biblioteca, por palabras o por la categoría de Garmin
    const muscles = (ex, cat) => { const e = info(ex);
      if (e && (e.main.length || e.sec.length)) return Object.fromEntries([...e.sec.map(k => [k, 1]), ...e.main.map(k => [k, 3])]);
      const n = nrm(ex); for (const [re, m] of EX_MUS) if (re.test(n)) return m; return (cat && GX_MUS[cat]) || null; };
    return { L: o, canon, info, muscles };
  }
  return { MUS, MUS_ES, EX_MUS, GX_MUS, KIND_MUS, DEF_EX, BANK_EX, nrm, library };
});
