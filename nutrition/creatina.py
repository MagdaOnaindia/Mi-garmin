"""¿La creatina cambia algo? Compara tus periodos con y sin creatina.

Uso:
    python3 ~/Projects/Garmin/nutrition/creatina.py

La creatina no actúa el mismo día que la tomas: el músculo se satura en ~3-4 semanas
con 3-5 g/día y vuelve a su nivel basal ~4-6 semanas después de dejarla. Por eso el
script no compara "día que la tomé" con "día que no", sino estados:
    saturada  = la tomaste al menos 20 de los últimos 28 días
    sin       = ninguna toma en los últimos 35 días
    transición = el resto (cargando o lavando). Se excluye del análisis.

Un día cuenta como "registrado" si tiene comidas en Cronometer o el hábito "creatina"
en la app del móvil. Los días sin registro no se cuentan como "no tomada".

Como la fase del ciclo mueve el peso, la VFC y la FC en reposo, cada medida se compara
también corregida por fase (restando la media de tu fase). Escribe data/creatina.json
para que el dashboard pueda mostrarlo.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path
from statistics import mean, stdev

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "garmin.db"
OUT = ROOT / "data" / "creatina.json"
MIN_N = 14  # días mínimos en cada grupo para opinar

OUTCOMES = [  # clave, etiqueta, ¿más alto es mejor?
    ("peso", "Peso (kg)", None),
    ("hrv_night", "VFC nocturna (ms)", True),
    ("rhr", "FC en reposo (lpm)", False),
    ("sleep_score", "Puntuación de sueño", True),
    ("sleep_h", "Horas de sueño", True),
    ("bb_wake", "Body Battery al despertar", True),
    ("readiness", "Preparación para entrenar", True),
    ("stress_avg", "Estrés medio", False),
    ("energy", "Energía (app/atajo)", True),
    ("mood", "Ánimo (app/atajo)", True),
    ("rpe_fuerza", "Esfuerzo percibido en fuerza/HIIT", None),
]


def q(con, sql, *a):
    try:
        return con.execute(sql, a).fetchall()
    except sqlite3.OperationalError:
        return []  # tabla aún no creada


def phase(day, L, P):
    if not day:
        return None
    L, P = L or 28, P or 5
    ov = L - 14
    return "Menstrual" if day <= P else "Folicular" if day < ov - 1 else "Ovulatoria" if day <= ov + 1 else "Lútea"


def load(con):
    took, logged = {}, set()
    for (d,) in q(con, "SELECT DISTINCT date FROM nut_servings"):
        logged.add(d)
    for (d,) in q(con, "SELECT DISTINCT date FROM supplements WHERE supplement='creatina'"):
        took[d] = 1
        logged.add(d)
    for d, v in q(con, "SELECT date, value FROM app_log WHERE kind='habit' AND key='creatina'"):
        logged.add(d)
        if v and v > 0:
            took[d] = 1

    days = {}
    for r in q(con, "SELECT date, hrv_night, rhr, sleep_score, sleep_s, bb_wake, readiness, stress_avg, "
                    "cycle_day, cycle_len, period_len FROM daily"):
        d = r[0]
        days[d] = dict(hrv_night=r[1], rhr=r[2], sleep_score=r[3],
                       sleep_h=r[4] / 3600 if r[4] else None, bb_wake=r[5], readiness=r[6],
                       stress_avg=r[7], phase=phase(r[8], r[9], r[10]))
    for d, v in q(con, "SELECT date, value FROM app_log WHERE kind='metric' AND key='peso'"):
        days.setdefault(d, {})["peso"] = v
    for d, v in q(con, "SELECT date, avg(value) FROM nut_biometrics WHERE lower(metric) LIKE 'weight%' "
                       "AND lower(unit) LIKE 'kg%' GROUP BY date"):
        days.setdefault(d, {}).setdefault("peso", v)
    for d, m, e in q(con, "SELECT date, avg(mood), avg(energy) FROM mood_log GROUP BY date"):
        days.setdefault(d, {}).update(mood=m, energy=e)
    for d, v in q(con, "SELECT date, avg(rpe) FROM activities WHERE rpe IS NOT NULL "
                       "AND category IN ('Fuerza','HIIT') GROUP BY date"):
        days.setdefault(d, {})["rpe_fuerza"] = v
    return took, logged, days


def status(d: date, took, logged):
    last28 = [(d - timedelta(i)).isoformat() for i in range(28)]
    last35 = [(d - timedelta(i)).isoformat() for i in range(35)]
    if sum(1 for x in last28 if took.get(x)) >= 20:
        return "saturada"
    known35 = [x for x in last35 if x in logged]
    if len(known35) >= 25 and not any(took.get(x) for x in last35):
        return "sin"
    return "transición"


def cohen_d(a, b):
    if len(a) < 2 or len(b) < 2:
        return None
    sp = (((len(a) - 1) * stdev(a) ** 2 + (len(b) - 1) * stdev(b) ** 2) / (len(a) + len(b) - 2)) ** 0.5
    return (mean(a) - mean(b)) / sp if sp else None


def analyse(con):
    took, logged, days = load(con)
    if not days:
        return {"estado": "sin datos"}
    for d in days:
        days[d]["grupo"] = status(date.fromisoformat(d), took, logged)

    # media por fase para corregir el efecto del ciclo
    phase_mean = {}
    for key, *_ in OUTCOMES:
        by = {}
        for v in days.values():
            if v.get(key) is not None and v.get("phase"):
                by.setdefault(v["phase"], []).append(v[key])
        phase_mean[key] = {p: mean(x) for p, x in by.items() if len(x) >= 3}

    res = []
    for key, label, higher in OUTCOMES:
        g = {"saturada": [], "sin": []}
        adj = {"saturada": [], "sin": []}
        for v in days.values():
            x, grp = v.get(key), v.get("grupo")
            if x is None or grp not in g:
                continue
            g[grp].append(x)
            pm = phase_mean[key].get(v.get("phase"))
            if pm is not None:
                adj[grp].append(x - pm)
        a, b = g["saturada"], g["sin"]
        row = {"clave": key, "medida": label, "n_con": len(a), "n_sin": len(b),
               "media_con": round(mean(a), 2) if a else None,
               "media_sin": round(mean(b), 2) if b else None}
        if len(a) >= MIN_N and len(b) >= MIN_N:
            d_raw = cohen_d(a, b)
            d_adj = cohen_d(adj["saturada"], adj["sin"]) if min(len(adj["saturada"]), len(adj["sin"])) >= MIN_N else None
            d_use = d_adj if d_adj is not None else d_raw
            row.update(diferencia=round(mean(a) - mean(b), 2),
                       d=round(d_raw, 2) if d_raw is not None else None,
                       d_por_fase=round(d_adj, 2) if d_adj is not None else None)
            if d_use is None or abs(d_use) < 0.3:
                row["lectura"] = "sin diferencia clara"
            else:
                size = "grande" if abs(d_use) >= 0.8 else "moderada" if abs(d_use) >= 0.5 else "pequeña"
                dirn = "más alto" if d_use > 0 else "más bajo"
                row["lectura"] = f"{dirn} con creatina (diferencia {size})"
        else:
            row["lectura"] = f"faltan datos (necesito {MIN_N} días en cada estado)"
        res.append(row)

    counts = {k: sum(1 for v in days.values() if v["grupo"] == k) for k in ("saturada", "sin", "transición")}
    return {"generado": date.today().isoformat(), "dias_con_toma": len(took),
            "dias_registrados": len(logged), "dias_por_estado": counts, "medidas": res,
            "nota": "Observacional: compara tus periodos, no demuestra causa. Si cambias a la vez dieta, "
                    "entrenamiento o sueño, el efecto se mezcla."}


def main():
    con = sqlite3.connect(DB)
    r = analyse(con)
    OUT.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
    if r.get("estado") == "sin datos":
        sys.exit("Aún no hay datos diarios en garmin.db.")
    c = r["dias_por_estado"]
    print(f"Días con creatina registrada: {r['dias_con_toma']} · días con registro: {r['dias_registrados']}")
    print(f"Estados: saturada {c['saturada']} · sin creatina {c['sin']} · transición {c['transición']}\n")
    for m in r["medidas"]:
        con_s = f"{m['media_con']}" if m["media_con"] is not None else "–"
        sin_s = f"{m['media_sin']}" if m["media_sin"] is not None else "–"
        print(f"{m['medida']:<34} con {con_s:>7} (n={m['n_con']:>3})  sin {sin_s:>7} (n={m['n_sin']:>3})  {m['lectura']}")
    print(f"\n{r['nota']}\n→ {OUT}")


if __name__ == "__main__":
    main()
