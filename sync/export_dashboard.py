"""Calcula métricas derivadas desde data/garmin.db y escribe dashboard/data.js.

Solo usa la librería estándar. Las reglas y umbrales están explicados en research/.
"""
from __future__ import annotations

import json
import sqlite3
import statistics as st
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dashboard" / "data.js"

CATS = ["HIIT", "Fuerza", "Movilidad", "Bici", "Cinta", "Caminar", "Otro"]

# Ánimos que Garmin permite registrar en Salud femenina, clasificados como positivos o negativos
MOOD_POS = {"HAPPY", "CALM", "ENERGETIC", "CONFIDENT", "MOTIVATED", "RELAXED", "CONTENT", "FOCUSED", "PRODUCTIVE"}
MOOD_NEG = {"SAD", "ANXIOUS", "IRRITABLE", "STRESSED", "ANGRY", "DEPRESSED", "MOOD_SWINGS", "UNMOTIVATED",
            "TIRED", "FATIGUED", "SENSITIVE", "OVERWHELMED", "UNFOCUSED"}
OUTCOMES = [("mood", "Ánimo (1–5)", 1), ("energy", "Energía (1–5)", 1), ("sleep_score", "Puntuación de sueño", 0),
            ("sleep_h", "Horas de sueño", 1), ("hrv_night", "VFC (ms)", 0), ("rhr", "FC reposo (lpm)", 1),
            ("stress_avg", "Estrés medio", 0), ("bb_wake", "Body Battery al despertar", 0)]
PROTEIN_TARGET = 1.6  # g/kg/día, Morton et al. 2018 (ver research/06-nutricion.md)
MIN_N = 8  # días por grupo antes de enseñar una relación como tendencia
# Ingesta diaria recomendada, mujer adulta 19–50 años (NIH ODS / IOM; fibra: EFSA 25 g). Ver research/06-nutricion.md
MICROS = [  # clave, prefijo del nutriente en Cronometer, etiqueta, unidad, objetivo
    ("fiber", "fiber", "Fibra", "g", 25), ("iron", "iron", "Hierro", "mg", 18),
    ("calcium", "calcium", "Calcio", "mg", 1000), ("vitd", "vitamin d", "Vitamina D", "µg", 15),
    ("magnesium", "magnesium", "Magnesio", "mg", 310), ("b12", "b12", "Vitamina B12", "µg", 2.4),
    ("folate", "folate", "Folato", "µg", 400), ("zinc", "zinc", "Zinc", "mg", 8),
    ("potassium", "potassium", "Potasio", "mg", 2600),
]


def truthy(v):
    try:
        v = json.loads(v) if isinstance(v, str) else v
    except ValueError:
        pass
    if isinstance(v, str):
        return v.strip().upper() not in ("", "NO", "NONE", "FALSE", "0", "NOT_LOGGED")
    return bool(v)


def garmin_mood_score(moods):
    """Ánimos de Garmin (texto) -> 1..5. Positivos suben y negativos bajan; mezcla = 3."""
    if not moods:
        return None
    ms = [m.strip().upper() for m in moods.split(",") if m.strip()]
    p = sum(m in MOOD_POS for m in ms)
    n = sum(m in MOOD_NEG for m in ms)
    return round(3 + 2 * (p - n) / (p + n), 2) if p + n else None


def mean(xs):
    xs = [x for x in xs if x is not None]
    return st.fmean(xs) if xs else None


def sd(xs):
    xs = [x for x in xs if x is not None]
    return st.stdev(xs) if len(xs) > 1 else None


def window(rows, i, n, key):
    """Valores de `key` en los n días que terminan en i (incluido)."""
    return [r.get(key) for r in rows[max(0, i - n + 1): i + 1]]


def phase(day, cycle_len, period_len):
    """Fase estimada. La ovulación se estima ~14 días antes del siguiente ciclo (sin confirmar)."""
    if not day:
        return None
    L, P = cycle_len or 28, period_len or 5
    ov = L - 14
    if day <= P:
        return "Menstrual"
    if day < ov - 1:
        return "Folicular"
    if day <= ov + 1:
        return "Ovulatoria"
    return "Lútea"


def grade(v, green, amber, higher_is_better=True):
    if v is None:
        return None
    if not higher_is_better:
        v, green, amber = -v, -green, -amber
    return 2 if v >= green else 1 if v >= amber else 0


def load_app_config(path=ROOT / "data" / "app_config.json"):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, PermissionError, OSError, ValueError):
        return {"habits": [], "metrics": []}


def metric_role(m):
    """Reconoce peso, proteína y kcal ingeridas en la configuración de la app, por clave, nombre o unidad."""
    txt = f'{m.get("key", "")} {m.get("label", "")}'.lower()
    unit = (m.get("unit") or "").lower()
    if "peso" in txt or "weight" in txt or unit == "kg":
        return "weight"
    if "prote" in txt:
        return "protein"
    if "kcal" in txt or "calor" in txt or unit == "kcal":
        return "kcal_in"
    return None


def q(con, sql, *a):
    try:
        return list(con.execute(sql, a))
    except sqlite3.OperationalError:
        return []  # tabla de Cronometer aún no creada


def micro_value(name, unit, value):
    """Pasa a la unidad del objetivo: Cronometer da la vitamina D en UI y a veces mcg en vez de µg."""
    u = (unit or "").lower()
    if name.lower().startswith("vitamin d") and u == "iu":
        return value / 40
    return value


def load_creatine_state(con):
    """Estado de creatina por día con la misma regla que nutrition/creatina.py (saturada = ≥20 tomas en 28 días)."""
    try:
        sys.path.insert(0, str(ROOT / "nutrition"))
        import creatina
        took, logged, _ = creatina.load(con)
        return lambda d: creatina.status(date.fromisoformat(d), took, logged) if took or logged else None
    except Exception:
        return lambda d: None


def load_creatina_json(path=ROOT / "data" / "creatina.json"):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, PermissionError, OSError, ValueError):
        return None


def hr_zones(con):
    """Zonas de pulso de Garmin (perfil DEFAULT): [{zona, desde}], fc_max. None si aún no se han descargado."""
    try:
        row = con.execute("SELECT json FROM raw WHERE endpoint='hr_zones' ORDER BY date DESC LIMIT 1").fetchone()
        prof = next((z for z in json.loads(row[0]) if z.get("sport") == "DEFAULT"), None) if row else None
        if not prof:
            return None
        return {"fc_max": prof.get("maxHeartRateUsed"), "metodo": prof.get("trainingMethod"),
                "desde": [prof.get(f"zone{i}Floor") for i in range(1, 6)]}
    except Exception:
        return None


def garmin_workouts(con):
    """Entrenamientos de Connect que se han usado: [{id, name, updated, steps, rest_idx}]. fit_index es la posición del paso
    en el reloj (los pasos de dentro de una repetición van antes que la repetición), la misma que wktStepIndex de cada serie."""
    try:
        out = []
        for ep, js in con.execute("SELECT endpoint, json FROM raw WHERE endpoint LIKE 'workout:%'"):
            w, steps, rest, n = json.loads(js) or {}, [], [], [0]

            def walk(ss, reps=1):
                for s in sorted(ss, key=lambda x: x.get("stepOrder") or 0):
                    if s.get("workoutSteps"):  # repetición: primero sus pasos, luego ella
                        walk(s["workoutSteps"], s.get("numberOfIterations") or 1)
                        n[0] += 1
                        continue
                    i = n[0]
                    n[0] += 1
                    cat, kind = s.get("category"), dig_type(s)
                    if kind in ("rest", "recovery") or (not cat and str(s.get("description") or "").lower().startswith(("rest", "descanso"))):
                        rest.append(i)
                        continue
                    ec = (s.get("endCondition") or {}).get("conditionTypeKey")
                    steps.append({"notes": s.get("description"), "exercise": {"category": cat, "name": s.get("exerciseName") or None},
                                  "reps": s.get("endConditionValue") if ec == "reps" else None,
                                  "duration_s": s.get("endConditionValue") if ec == "time" else None,
                                  "weight_kg": s.get("weightValue"), "sets": reps, "fit_index": i})

            for seg in w.get("workoutSegments") or []:
                walk(seg.get("workoutSteps") or [])
            out.append({"id": ep.split(":", 1)[1], "name": w.get("workoutName"), "updated": w.get("updatedDate"), "steps": steps, "rest_idx": rest})
        return out
    except Exception as e:
        print(f"  ! Entrenamientos de Connect no se exportaron: {e}", file=sys.stderr)
        return []


def dig_type(step):
    return ((step.get("stepType") or {}).get("stepTypeKey") or "").lower()


def activity_sets(con):
    """Series del reloj por actividad: {id: {workout_id, workout_name, sets: [...]}}. Cada serie, el ejercicio más probable.
    Fuera las series 'ACTIVE' de menos de 10 s sin repeticiones (toques de botón)."""
    try:
        wn = {}
        for ep, js in con.execute("SELECT endpoint, json FROM raw WHERE endpoint LIKE 'workout:%'"):
            w = json.loads(js) or {}
            wn[ep.split(":", 1)[1]] = w.get("workoutName")
        wid = {str(r[0]): json.loads(r[1]).get("workoutId") for r in con.execute(
            "SELECT id, raw FROM activities WHERE category IN ('Fuerza','HIIT','Movilidad') AND raw IS NOT NULL")}
        out = {}
        for ep, js in con.execute("SELECT endpoint, json FROM raw WHERE endpoint LIKE 'exercise_sets:%'"):
            aid, sets = ep.split(":", 1)[1], []
            for s in (json.loads(js) or {}).get("exerciseSets") or []:
                dur, reps = s.get("duration") or 0, s.get("repetitionCount")
                if s.get("setType") == "ACTIVE" and dur < 10 and not reps:
                    continue
                ex = max(s.get("exercises") or [{}], key=lambda e: e.get("probability") or 0)
                sets.append({"set_type": s.get("setType"), "exercise": {"category": ex.get("category"), "name": ex.get("name")} if ex else None,
                             "reps": reps, "weight_kg": s.get("weight"), "step_index": s.get("wktStepIndex"), "duration_s": round(dur, 1),
                             "start": (s.get("startTime") or "")[:19]})
            w = wid.get(aid)
            out[aid] = {"workout_id": w, "workout_name": wn.get(str(w)) if w else None, "sets": sets}
        return out
    except Exception as e:
        print(f"  ! Series del reloj no se exportaron: {e}", file=sys.stderr)
        return {}


def export(con: sqlite3.Connection, out: Path = OUT, var: str = "GARMIN_DATA", app_config=None, creatina=None) -> Path:
    con.row_factory = None
    creatine_state = load_creatine_state(con)
    # Cronometer: solo días marcados como completos (un día a medias falsearía las medias)
    nut = {r[0]: dict(kcal=r[1], protein=r[2], carbs=r[3], fat=r[4], fiber=r[5])
           for r in q(con, "SELECT date, kcal, protein_g, carbs_g, fat_g, fiber_g FROM nut_day WHERE completed = 1")}
    micro_rows = defaultdict(dict)
    for dt, name, unit, value in q(con, "SELECT date, nutrient, unit, value FROM nut_daily"):
        if dt not in nut:
            continue
        for key, prefix, *_ in MICROS:
            if name.lower().startswith(prefix) and key not in micro_rows[dt]:
                micro_rows[dt][key] = micro_value(name, unit, value)
    nut_weight = {r[0]: r[1] for r in q(con, "SELECT date, avg(value) FROM nut_biometrics WHERE lower(metric) LIKE 'weight%' "
                                             "AND lower(unit) LIKE 'kg%' GROUP BY date")}
    con.row_factory = sqlite3.Row
    days = [dict(r) for r in con.execute("SELECT * FROM daily ORDER BY date")]
    acts = [dict(r) for r in con.execute("SELECT * FROM activities ORDER BY start_local")]
    for a in acts:
        a.pop("raw", None)
        mins = (a["duration_s"] or 0) / 60
        a["minutes"] = round(mins, 1)
        a["srpe"] = round(a["rpe"] * mins, 1) if a.get("rpe") else None  # Foster 2001

    # Rellenar huecos de calendario para que las medias móviles sean por días reales
    if days:
        by_date = {d["date"]: d for d in days}
        d0, d1 = date.fromisoformat(days[0]["date"]), date.fromisoformat(days[-1]["date"])
        days = []
        while d0 <= d1:
            k = d0.isoformat()
            days.append(by_date.get(k, {"date": k}))
            d0 += timedelta(days=1)

    load_by_day = defaultdict(lambda: defaultdict(float))
    srpe_by_day = defaultdict(float)
    for a in acts:
        load_by_day[a["date"]][a["category"]] += a["load"] or 0
        srpe_by_day[a["date"]] += a["srpe"] or 0

    # Ánimo puntual (atajo) y hábitos, por día
    mood_rows = [dict(r) for r in con.execute("SELECT * FROM mood_log ORDER BY ts")]
    mood_by_day = defaultdict(list)
    for m in mood_rows:
        mood_by_day[m["date"]].append(m)
    habits = defaultdict(dict)
    for r in con.execute("SELECT date, behavior, value FROM lifestyle"):
        habits[r[0]][r[1]] = truthy(r[2])
    # App del móvil: hábitos sí/no y medidas
    cfg = app_config or load_app_config()
    step_goal = int(cfg.get("step_goal") or (cfg.get("goals") or {}).get("steps") or 10000)
    habit_label = {h["key"]: h.get("label") or h["key"] for h in cfg.get("habits", [])}
    metrics_cfg = [dict(m, role=metric_role(m)) for m in cfg.get("metrics", [])]
    role_key = {m["role"]: m["key"] for m in metrics_cfg if m["role"]}
    app_metrics = defaultdict(dict)
    try:
        app_rows = list(con.execute("SELECT date, kind, key, value FROM app_log"))
    except sqlite3.OperationalError:
        app_rows = []
    for dt, kind, key, value in app_rows:
        if kind == "habit":
            habits[dt][habit_label.get(key, key)] = bool(value)
        else:
            app_metrics[dt][key] = value
            if key not in {m["key"] for m in metrics_cfg}:
                metrics_cfg.append({"key": key, "label": key, "unit": "", "role": None})
    trained = {a["date"] for a in acts}
    trained_cat = defaultdict(set)
    for a in acts:
        trained_cat[a["date"]].add(a["category"])

    for i, d in enumerate(days):
        ms = mood_by_day.get(d["date"], [])
        d["mood_garmin"] = garmin_mood_score(d.get("moods"))
        d["mood_csv"] = round(mean([m["mood"] for m in ms]), 2) if ms and mean([m["mood"] for m in ms]) is not None else None
        d["mood"] = d["mood_csv"] if d["mood_csv"] is not None else d["mood_garmin"]
        d["energy"] = round(mean([m["energy"] for m in ms]), 2) if ms and mean([m["energy"] for m in ms]) is not None else None
        d["habits"] = habits.get(d["date"], {})
        n = nut.get(d["date"])
        if n:
            for k, v in n.items():
                d[f"nut_{k}"] = round(v, 1) if v is not None else None
        d["creatine"] = creatine_state(d["date"])
        for k, v in app_metrics.get(d["date"], {}).items():
            d[f"m_{k}"] = v
        d["sleep_h"] = round(d["sleep_s"] / 3600, 2) if d.get("sleep_s") else None
        d["phase"] = phase(d.get("cycle_day"), d.get("cycle_len"), d.get("period_len"))
        d["load"] = round(sum(load_by_day[d["date"]].values()), 1)
        d["load_cat"] = {c: round(load_by_day[d["date"]][c], 1) for c in CATS if load_by_day[d["date"]][c]}
        d["srpe"] = round(srpe_by_day[d["date"]], 1)

        hv = window(days, i, 7, "hrv_night")
        d["hrv_7d"] = round(mean(hv), 1) if len([x for x in hv if x]) >= 4 else None
        base = [x for x in window(days, i - 1, 60, "hrv_night") if x] if i else []
        d["hrv_base"] = round(mean(base), 1) if len(base) >= 14 else None
        d["hrv_base_sd"] = round(sd(base), 1) if len(base) >= 14 else None

        rb = [x for x in window(days, i - 1, 30, "rhr") if x] if i else []
        d["rhr_base"] = round(mean(rb), 1) if len(rb) >= 7 else None

        # Carga aguda (7 d) / crónica (28 d, media semanal). Solo con ≥21 días de histórico.
        if i >= 20:
            acute = sum(x["load"] for x in days[max(0, i - 6): i + 1])
            chronic = sum(x["load"] for x in days[max(0, i - 27): i + 1]) / (min(28, i + 1) / 7)
            d["acwr"] = round(acute / chronic, 2) if chronic else None
            d["load_7d"], d["load_28d_week"] = round(acute), round(chronic)
        else:
            d["acwr"] = None

    # Semáforo de hoy (heurística propia, ver research/00-metodologia.md)
    today = next((d for d in reversed(days) if d.get("rhr") or d.get("sleep_s") or d.get("hrv_night")), None)
    semaforo = None
    if today:
        comp = {}
        h = today.get("hrv_night")
        if h and today.get("hrv_base_low"):
            comp["VFC"] = 2 if h >= today["hrv_base_low"] else 1 if h >= 0.9 * today["hrv_base_low"] else 0
        elif h and today.get("hrv_base"):
            comp["VFC"] = grade(h, today["hrv_base"] - today["hrv_base_sd"], today["hrv_base"] - 2 * today["hrv_base_sd"])
        if today.get("rhr") and today.get("rhr_base"):
            comp["FC reposo"] = grade(today["rhr"] - today["rhr_base"], 2, 5, higher_is_better=False)
        comp["Sueño"] = grade(today.get("sleep_h"), 7, 6)
        comp["Body Battery"] = grade(today.get("bb_wake"), 50, 25)
        comp = {k: v for k, v in comp.items() if v is not None}
        if comp:
            avg = st.fmean(comp.values())
            level = "verde" if avg >= 1.6 else "ambar" if avg >= 1 else "rojo"
            semaforo = {"date": today["date"], "level": level, "components": comp}

    # Semanas (lunes a domingo)
    weeks = defaultdict(lambda: {"steps": [], "sleep_h": [], "im": 0, "load": 0.0, "srpe": 0.0,
                                 "sessions": defaultdict(int), "minutes": defaultdict(float)})
    for d in days:
        wk = (date.fromisoformat(d["date"]) - timedelta(days=date.fromisoformat(d["date"]).weekday())).isoformat()
        w = weeks[wk]
        w["steps"].append(d.get("steps"))
        w["sleep_h"].append(d.get("sleep_h"))
        w["im"] += (d.get("im_moderate") or 0) + 2 * (d.get("im_vigorous") or 0)
        w["load"] += d["load"]
        w["srpe"] += d["srpe"]
    for a in acts:
        wk = (date.fromisoformat(a["date"]) - timedelta(days=date.fromisoformat(a["date"]).weekday())).isoformat()
        weeks[wk]["sessions"][a["category"]] += 1
        weeks[wk]["minutes"][a["category"]] += a["minutes"]
    week_list = [
        {"week": k, "steps_avg": round(mean(v["steps"]) or 0), "sleep_avg": round(mean(v["sleep_h"]) or 0, 2) or None,
         "intensity_min": v["im"], "load": round(v["load"]), "srpe": round(v["srpe"]),
         "sessions": dict(v["sessions"]), "minutes": {c: round(m) for c, m in v["minutes"].items()}}
        for k, v in sorted(weeks.items())
    ]

    # Medias por fase del ciclo
    by_phase = defaultdict(list)
    for d in days:
        if d.get("phase"):
            by_phase[d["phase"]].append(d)
    phases = {}
    for p in ["Menstrual", "Folicular", "Ovulatoria", "Lútea"]:
        rows = by_phase.get(p, [])
        phases[p] = {"n": len(rows), **{k: (round(mean([r.get(k) for r in rows]), 1) if mean([r.get(k) for r in rows]) is not None else None)
                                        for k in ["mood", "energy", "hrv_night", "rhr", "sleep_h", "sleep_score", "bb_wake", "stress_avg", "readiness", "srpe"]}}

    # Nutrición: peso medio 7 d, proteína por kg y balance con el gasto de Garmin
    wk, pk, kk = role_key.get("weight"), role_key.get("protein"), role_key.get("kcal_in")
    last_w = None
    # Cronometer manda cuando el día está completo; si no, lo apuntado en la app del móvil
    for i, d in enumerate(days):
        d["weight"] = d.get(f"m_{wk}") if wk and d.get(f"m_{wk}") is not None else nut_weight.get(d["date"])
        d["protein_in"] = d.get("nut_protein") if d.get("nut_protein") is not None else d.get(f"m_{pk}") if pk else None
        d["kcal_in"] = d.get("nut_kcal") if d.get("nut_kcal") is not None else d.get(f"m_{kk}") if kk else None
        ws = [x for x in window(days, i, 7, "weight") if x]
        d["weight_7d"] = round(mean(ws), 2) if ws else None
        last_w = d["weight"] or last_w
        if d["protein_in"] is not None and last_w:
            d["protein_gkg"] = round(d["protein_in"] / last_w, 2)
        if d["kcal_in"] is not None and d.get("kcal_total"):
            d["energy_balance"] = round(d["kcal_in"] - d["kcal_total"])

    # Micronutrientes: media de los últimos 7 y 28 días completos frente a la ingesta recomendada
    nut_dates = sorted(micro_rows)
    micros = []
    for key, _, label, unit, target in MICROS:
        row = {"key": key, "label": label, "unit": unit, "target": target}
        for span in (7, 28):
            vals = [micro_rows[x][key] for x in nut_dates[-span:] if micro_rows[x].get(key) is not None]
            row[f"avg{span}"] = round(mean(vals), 1) if vals else None
            row[f"n{span}"] = len(vals)
            row[f"pct{span}"] = round(100 * mean(vals) / target) if vals else None
        micros.append(row)
    macro_days = [x for x in nut_dates[-7:] if all(nut[x].get(k) is not None for k in ("protein", "carbs", "fat"))]
    macro_split = None
    if macro_days:
        kc = {k: mean([nut[x][k] for x in macro_days]) * f for k, f in (("protein", 4), ("carbs", 4), ("fat", 9))}
        tot = sum(kc.values())
        macro_split = {"n": len(macro_days), **{k: round(100 * v / tot) for k, v in kc.items()}} if tot else None

    # Relaciones: días con el factor frente a días sin él
    yday = lambda i, f: f(days[i - 1]) if i > 0 else None
    factors = {
        "Entrené hoy": lambda i: days[i]["date"] in trained,
        "Entrené ayer": lambda i: yday(i, lambda x: x["date"] in trained),
        "Tabata (HIIT) ayer": lambda i: yday(i, lambda x: "HIIT" in trained_cat[x["date"]]),
        "Fuerza ayer": lambda i: yday(i, lambda x: bool({"Fuerza", "Movilidad"} & trained_cat[x["date"]])),
        "Dormí 7 h o más": lambda i: None if days[i].get("sleep_h") is None else days[i]["sleep_h"] >= 7,
        f"Llegué a {step_goal:,} pasos ayer".replace(",", "."): lambda i: yday(i, lambda x: None if x.get("steps") is None else x["steps"] >= step_goal),
        "Proteína ≥ 1,6 g/kg": lambda i: None if days[i].get("protein_gkg") is None else days[i]["protein_gkg"] >= PROTEIN_TARGET,
        "Proteína suficiente ayer": lambda i: yday(i, lambda x: None if x.get("protein_gkg") is None else x["protein_gkg"] >= PROTEIN_TARGET),
        # Saturada frente a sin creatina; los días en transición (cargando o lavando) no cuentan
        "Creatina saturada": lambda i: {"saturada": True, "sin": False}.get(days[i].get("creatine")),
    }
    for ph in ["Menstrual", "Folicular", "Ovulatoria", "Lútea"]:
        factors[f"Fase {ph.lower()}"] = (lambda ph: lambda i: None if not days[i].get("phase") else days[i]["phase"] == ph)(ph)
    for h in sorted({h for d in days for h in d["habits"]}):
        factors[f"Hábito: {h}"] = (lambda h: lambda i: days[i]["habits"].get(h) if days[i]["habits"] else None)(h)
    outcomes = OUTCOMES + [(f"m_{m['key']}", f"{m.get('label') or m['key']}" + (f" ({m['unit']})" if m.get("unit") else ""), 1)
                           for m in metrics_cfg if m["role"] not in ("weight", "kcal_in")]
    relations = []
    for fname, f in factors.items():
        flags = [f(i) for i in range(len(days))]
        for key, label, dec in outcomes:
            if fname.startswith("Dormí") and key == "sleep_h":
                continue  # tautología
            if fname.startswith("Proteína") and pk and key == f"m_{pk}":
                continue
            if fname.startswith("Creatina") and key == "m_creatina":
                continue
            yes = [d[key] for d, fl in zip(days, flags) if fl is True and d.get(key) is not None]
            no = [d[key] for d, fl in zip(days, flags) if fl is False and d.get(key) is not None]
            if not yes or not no:
                continue
            my, mn_ = mean(yes), mean(no)
            pooled = sd(yes + no)
            relations.append({"factor": fname, "outcome": label, "key": key,
                              "with": round(my, dec + 1), "without": round(mn_, dec + 1),
                              "diff": round(my - mn_, dec + 1),
                              "effect": round((my - mn_) / pooled, 2) if pooled else None,  # diferencia en desviaciones típicas
                              "n_with": len(yes), "n_without": len(no),
                              "enough": len(yes) >= MIN_N and len(no) >= MIN_N})
    relations.sort(key=lambda r: (not r["enough"], -abs(r["effect"] or 0)))

    # Perfil por día del ciclo
    by_cd = defaultdict(list)
    for d in days:
        if d.get("cycle_day"):
            by_cd[d["cycle_day"]].append(d)
    cycle_profile = [{"day": cd, "n": len(rows), **{k: (round(mean([r.get(k) for r in rows]), 2) if mean([r.get(k) for r in rows]) is not None else None)
                                                     for k in ["mood", "energy", "sleep_score", "sleep_h", "hrv_night", "rhr"]}}
                     for cd, rows in sorted(by_cd.items())]

    notes = [m for m in mood_rows if m.get("note")][-20:]

    data = {
        "generated_at": datetime.now().isoformat(timespec="minutes"),
        "days": days, "activities": acts, "weeks": week_list, "phases": phases, "semaforo": semaforo,
        "categories": CATS, "relations": relations, "cycle_profile": cycle_profile,
        "mood_log": mood_rows[-200:], "notes": notes, "min_n": MIN_N,
        "metrics_config": metrics_cfg, "nutrition_keys": {"weight": wk, "protein": pk, "kcal_in": kk},
        "protein_target": PROTEIN_TARGET, "step_goal": step_goal, "hr_zones": hr_zones(con), "activity_sets": activity_sets(con), "garmin_workouts": garmin_workouts(con),
        "health_snapshots": [{k: r[k] for k in ("date", "time", "hr", "hrv", "resp", "spo2", "stress")}
                             for r in q(con, "SELECT date, time, hr, hrv, resp, spo2, stress FROM health_snapshot ORDER BY ts")],
        "micros": micros, "macro_split": macro_split, "nutrition_days": len(nut_dates),
        "creatina": creatina if creatina is not None else load_creatina_json(),
    }
    out.parent.mkdir(exist_ok=True)
    out.write_text(f"window.{var} = " + json.dumps(data, ensure_ascii=False, default=str) + ";\n")
    return out


if __name__ == "__main__":
    print(export(sqlite3.connect(ROOT / "data" / "garmin.db")))
