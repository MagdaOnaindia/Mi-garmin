"""Aviso de posible enfermedad: compara la noche de hoy con tu propia línea base.

Lee data/garmin.db (tablas daily, raw, activities, app_log) y escribe data/aviso_salud.json:
  {"fecha", "nivel": "verde"|"amarillo"|"rojo"|"calibrando"|"sin_datos", "titulo", "texto",
   "senales": [...], "posibles_causas": [...], "noches_base", "fase", "avisar": bool}

Idea (estudios con wearables: Mishra 2020, Radin 2020, Quer 2021, Natarajan 2020): días antes de
notar síntomas suelen subir el pulso en reposo y la respiración nocturna y bajar la VFC. Una señal
sola casi nunca significa nada; varias a la vez, sí.

Señales de cada noche, frente a la mediana de tus 28 noches anteriores (mínimo 7):
  pulso        FC en reposo o FC media del sueño  >= base + max(3 lpm, 1,5 desv.)   (+6 lpm cuenta doble)
  vfc          VFC nocturna                       <= base - max(10 %, 1,5 desv.)   (-20 % cuenta doble)
  respiracion  respiraciones/min durante el sueño >= base + max(0,8, 1,5 desv.)    (+1,5 cuenta doble)
  estres       estrés medio durante el sueño       >= base + max(8, 1,5 desv.)
  recarga      Body Battery recargado durmiendo    <= base - max(20, 1,5 desv.)
Nivel: 0-1 puntos verde, 2-3 amarillo, 4+ rojo. Dos amarillos seguidos también son rojo.
Ciclo: en fase lútea (desde ~día 15 hasta la regla) se espera algo más de pulso y respiración y menos
VFC, así que se descuenta antes de comparar. Los días que apuntes en la app que estás mala no entran
en la línea base. Un entreno intenso la víspera o dormir menos de 6 h se nombran como posible causa.

Uso: python3 sync/aviso_salud.py [--fecha AAAA-MM-DD] [--db ruta] [--salida ruta]
Solo usa la biblioteca estándar.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent.parent
BASE_NOCHES = 28
MIN_NOCHES = 7
CLAVES_MALA = ("mala", "enferma", "estoy_mala", "malestar")

# Desplazamiento esperado en fase lútea (literatura: FC +2-3 lpm, VFC -5-10 %, resp. +0,2-0,5)
LUTEA = {"pulso": 2.0, "vfc_pct": 0.06, "respiracion": 0.3}

# señal: (dirección, umbral mínimo, umbral doble, desv. mínima, unidad, nombre)
REGLAS = {
    "pulso": (+1, 3.0, 6.0, 1.5, "lpm", "pulso en reposo"),
    "vfc": (-1, 0.10, 0.20, None, "ms", "VFC nocturna"),
    "respiracion": (+1, 0.8, 1.5, 0.3, "rpm", "respiración al dormir"),
    "estres": (+1, 8.0, None, 3.0, "", "estrés durante el sueño"),
    "recarga": (-1, 20.0, None, 5.0, "", "recarga de Body Battery"),
}


def noche(db: sqlite3.Connection, d: str) -> dict:
    """Valores de la noche que termina el día d."""
    v: dict = {}
    r = db.execute("select rhr, hrv_night, resp_sleep, bb_charged, sleep_s, cycle_day, cycle_len "
                   "from daily where date=?", (d,)).fetchone()
    if r:
        v.update(rhr=r[0], vfc=r[1], respiracion=r[2], recarga=r[3], sueno_s=r[4],
                 dia_ciclo=r[5], ciclo=r[6])
    raw = db.execute("select json from raw where date=? and endpoint='sleep'", (d,)).fetchone()
    if raw:
        try:
            x = json.loads(raw[0])
            dto = x.get("dailySleepDTO") or {}
            v["fc_sueno"] = dto.get("avgHeartRate")
            v["estres"] = dto.get("avgSleepStress")
            v["respiracion"] = v.get("respiracion") or dto.get("averageRespirationValue")
            if v.get("recarga") is None:
                v["recarga"] = x.get("bodyBatteryChange")
            v["vfc"] = v.get("vfc") or x.get("avgOvernightHrv")
        except (ValueError, TypeError):
            pass
    return {k: x for k, x in v.items() if x is not None}


def dias_mala(db: sqlite3.Connection) -> set[str]:
    try:
        q = "select date from app_log where value>0 and key in (%s)" % ",".join("?" * len(CLAVES_MALA))
        return {r[0] for r in db.execute(q, CLAVES_MALA)}
    except sqlite3.Error:
        return set()


def lutea(n: dict) -> bool:
    dc, cl = n.get("dia_ciclo"), n.get("ciclo") or 28
    return bool(dc) and dc >= cl - 13


def ajustar(n: dict) -> dict:
    """Quita el efecto esperado de la fase lútea para comparar noches de fases distintas."""
    a = dict(n)
    if lutea(n):
        for k in ("rhr", "fc_sueno"):
            if k in a:
                a[k] -= LUTEA["pulso"]
        if "vfc" in a:
            a["vfc"] /= (1 - LUTEA["vfc_pct"])
        if "respiracion" in a:
            a["respiracion"] -= LUTEA["respiracion"]
    return a


def desv(xs: list[float]) -> float:
    m = median(xs)
    return 1.4826 * median([abs(x - m) for x in xs]) if len(xs) > 2 else 0.0


def evaluar(db: sqlite3.Connection, hoy: str, previo: dict | None = None) -> dict:
    d0 = date.fromisoformat(hoy)
    mala = dias_mala(db)
    actual = noche(db, hoy)
    fase = "lútea" if lutea(actual) else ("regla" if (actual.get("dia_ciclo") or 99) <= 5 else "folicular")
    out = {"fecha": hoy, "fase": fase, "dia_ciclo": actual.get("dia_ciclo"), "senales": [],
           "posibles_causas": [], "puntos": 0}
    # solo con la noche terminada: a mitad de noche la recarga y la VFC salen incompletas
    if "sueno_s" not in actual or not any(k in actual for k in ("vfc", "respiracion")):
        return {**out, "nivel": "sin_datos", "titulo": "Sin datos de esta noche",
                "texto": "Aún no hay datos del sueño de hoy. Sincroniza el reloj.", "avisar": False}

    base: dict[str, list[float]] = {k: [] for k in ("rhr", "fc_sueno", "vfc", "respiracion", "estres", "recarga")}
    noches = 0
    for i in range(1, BASE_NOCHES + 1):
        d = (d0 - timedelta(days=i)).isoformat()
        if d in mala or (d0 - timedelta(days=i - 1)).isoformat() in mala:
            continue  # ni el día que estabas mala ni la noche previa
        n = noche(db, d)
        if not any(k in n for k in ("rhr", "vfc", "respiracion")):
            continue
        noches += 1
        for k, x in ajustar(n).items():
            if k in base:
                base[k].append(float(x))
    out["noches_base"] = noches
    a = ajustar(actual)

    def comparar(clave, valor, serie, nombre_regla):
        sentido, minimo, doble, dmin, unidad, nombre = REGLAS[nombre_regla]
        if valor is None or len(serie) < 3:
            return None
        m, s = median(serie), max(desv(serie), dmin or 0)
        if nombre_regla == "vfc":
            umbral, umbral2 = max(minimo * m, 1.5 * s), doble * m
        else:
            umbral, umbral2 = max(minimo, 1.5 * s), doble
        dif = (valor - m) * sentido
        if dif < umbral:
            return None
        pts = 2 if umbral2 is not None and dif >= max(umbral2, umbral) else 1
        return {"senal": nombre_regla, "nombre": nombre, "valor": round(actual.get(clave, valor), 1),
                "base": round(m, 1), "dif": round(valor - m, 1), "unidad": unidad, "puntos": pts}

    # pulso: cuenta una sola vez, el más llamativo de FC en reposo y FC media del sueño
    p = [comparar(k, a.get(k), base[k], "pulso") for k in ("rhr", "fc_sueno")]
    p = [x for x in p if x]
    if p:
        out["senales"].append(max(p, key=lambda x: (x["puntos"], x["dif"])))
    for k in ("vfc", "respiracion", "estres", "recarga"):
        s = comparar(k, a.get(k), base[k], k)
        if s:
            out["senales"].append(s)
    pts = sum(s["puntos"] for s in out["senales"])
    out["puntos"] = pts

    # posibles causas que no son un virus
    ayer = (d0 - timedelta(days=1)).isoformat()
    try:
        r = db.execute("select coalesce(sum(load),0), coalesce(sum(im_vigorous),0), max(anaerobic_te) "
                       "from activities where date=?", (ayer,)).fetchone()
        if r and (r[0] >= 150 or r[1] >= 30 or (r[2] or 0) >= 3):
            out["posibles_causas"].append("entreno intenso ayer")
    except sqlite3.Error:
        pass
    if (actual.get("sueno_s") or 99999) < 6 * 3600:
        out["posibles_causas"].append("dormiste menos de 6 h")
    if fase == "regla":
        out["posibles_causas"].append("primeros días de regla")

    calibrando = noches < MIN_NOCHES
    if pts >= 4:
        nivel = "rojo"
    elif pts >= 2:
        nivel = "rojo" if previo and previo.get("fecha") == ayer and previo.get("nivel") in ("amarillo", "rojo") else "amarillo"
    else:
        nivel = "verde"
    if calibrando and nivel != "rojo":
        nivel = "calibrando"
    out["nivel"] = nivel

    nombres = ", ".join(s["nombre"] for s in out["senales"]) or "nada fuera de lo normal"
    causas = (" Puede deberse a: " + ", ".join(out["posibles_causas"]) + ".") if out["posibles_causas"] else ""
    if nivel == "rojo":
        out["titulo"] = "Tu cuerpo está luchando contra algo"
        out["texto"] = (f"Varias señales a la vez: {nombres}. Es probable que te estés poniendo mala."
                        f"{causas} Hoy mejor descanso o algo suave, bebe agua y acuéstate pronto.")
    elif nivel == "amarillo":
        out["titulo"] = "Vigila cómo te encuentras"
        out["texto"] = (f"Fuera de lo normal: {nombres}.{causas} Si mañana sigue igual, toca bajar el ritmo.")
    elif nivel == "calibrando":
        out["titulo"] = "Aprendiendo tu normalidad"
        out["texto"] = (f"Llevo {noches} de {MIN_NOCHES} noches para tu línea base. "
                        f"Solo aviso si algo es muy evidente. Hoy: {nombres}.")
    else:
        out["titulo"] = "Todo en tu normalidad"
        out["texto"] = "Pulso, VFC y respiración dentro de tu rango."
    out["avisar"] = nivel in ("amarillo", "rojo")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fecha", default=datetime.now().date().isoformat())
    ap.add_argument("--db", default=str(ROOT / "data" / "garmin.db"))
    ap.add_argument("--salida", default=str(ROOT / "data" / "aviso_salud.json"))
    a = ap.parse_args()
    salida = Path(a.salida)
    hist = []
    if salida.exists():
        try:
            hist = [h for h in json.loads(salida.read_text()).get("historial", []) if h["fecha"] != a.fecha]
        except (ValueError, KeyError):
            pass
    ayer = (date.fromisoformat(a.fecha) - timedelta(days=1)).isoformat()
    previo = next((h for h in hist if h["fecha"] == ayer), None)
    db = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    res = evaluar(db, a.fecha, previo)
    hist = (hist + [{k: res[k] for k in ("fecha", "nivel", "puntos")}])[-60:]
    tmp = salida.with_suffix(".tmp")
    tmp.write_text(json.dumps({"hoy": res, "historial": hist}, ensure_ascii=False, indent=1))
    tmp.replace(salida)
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
