"""Genera dashboard/demo.js con 90 días INVENTADOS para ver cómo será el dashboard.

No toca tus datos reales. Uso: python3 ~/Projects/Garmin/sync/make_demo.py
"""
import math
import random
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

from export_dashboard import export
from garmin_sync import SCHEMA

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "nutrition"))
from cronometer_import import SCHEMA as NUT_SCHEMA  # noqa: E402
from creatina import analyse  # noqa: E402
random.seed(7)
con = sqlite3.connect(":memory:")
con.executescript(SCHEMA)
con.executescript(NUT_SCHEMA)
start = date(2026, 7, 1)
aid = 1
for i in range(90):
    d = start + timedelta(days=i)
    cd = i % 28 + 1
    luteal = cd > 15
    hrv = 48 + 6 * math.sin(i / 9) - (4 if luteal else 0) + random.gauss(0, 4)
    rhr = 60 + (2 if luteal else 0) + random.gauss(0, 1.5)
    sleep = random.gauss(7.1, 0.7)
    row = dict(date=d.isoformat(), steps=int(random.gauss(8500, 2500)), step_goal=10000, rhr=round(rhr),
               stress_avg=int(random.gauss(30, 8)), bb_wake=int(min(100, max(10, random.gauss(68, 15)))),
               bb_high=80, bb_low=15, im_moderate=int(random.gauss(15, 8)), im_vigorous=0,
               kcal_total=round(random.gauss(2050, 150)), sleep_s=int(sleep * 3600), deep_s=int(sleep * 3600 * .18), rem_s=int(sleep * 3600 * .22),
               light_s=int(sleep * 3600 * .55), awake_s=int(sleep * 3600 * .05),
               sleep_score=int(min(98, max(40, 60 + (sleep - 6) * 15 + random.gauss(0, 5)))),
               hrv_night=round(hrv), hrv_base_low=42 if i > 21 else None, hrv_base_high=58 if i > 21 else None,
               readiness=int(min(100, max(5, random.gauss(62, 15)))), vo2max=36 + i / 60,
               cycle_day=cd, cycle_len=28, period_len=5, flow="MEDIUM" if cd <= 4 else None,
               moods=random.choice(["HAPPY", "CALM", "HAPPY,ENERGETIC"] if not luteal or random.random() < .6 else ["IRRITABLE", "TIRED", "ANXIOUS"]))
    con.execute(f"INSERT INTO daily ({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values()))
    wd = d.weekday()
    trained_yday = (wd - 1) % 7 in (0, 1, 2, 3, 4, 5)
    for h in (9, 14, 21):
        if random.random() < .5:
            m = min(5, max(1, round(random.gauss(3.4 + (.4 if trained_yday else 0) - (.5 if luteal else 0), .8))))
            e = min(5, max(1, round(random.gauss(3.2 + (sleep - 7) * .5, .8))))
            con.execute("INSERT INTO mood_log VALUES (?,?,?,?,?,'csv')", (f"{d}T{h:02d}:00:00", d.isoformat(), m, e,
                        random.choice([None, None, None, "buen día en el trabajo", "cansada", "dolor de cabeza"])))
    alcohol = random.random() < .15
    w = 63 - i * 0.015 + random.gauss(0, 0.3)
    prot = random.gauss(95, 20)
    for kind, key, val in [("metric", "peso", round(w, 1)), ("metric", "proteina", round(prot)),
                           ("metric", "kcal", round(random.gauss(1850, 220))), ("metric", "agua", round(random.gauss(1.8, .4), 1)),
                           ("metric", "dolor", max(0, round(random.gauss(3 if cd <= 2 else 1, 1)))),
                           ("habit", "pantallas_noche", int(random.random() < .4))]:
        if kind == "metric" and key == "peso" and random.random() < .5:
            continue
        con.execute("INSERT INTO app_log VALUES (?,?,?,?,?)", (d.isoformat(), kind, key, val, f"{d}T22:00:00"))
    # Cronometer: ~75 % de días completos; creatina 5 g/día desde el día 45
    if random.random() < .85:
        nutr = {"Energy": ("kcal", random.gauss(1850, 220)), "Protein": ("g", prot), "Carbs": ("g", random.gauss(200, 35)),
                "Fat": ("g", random.gauss(65, 12)), "Fiber": ("g", random.gauss(21, 6)), "Iron": ("mg", random.gauss(12, 3)),
                "Calcium": ("mg", random.gauss(850, 200)), "Vitamin D": ("IU", random.gauss(240, 120)),
                "Magnesium": ("mg", random.gauss(300, 60)), "B12 (Cobalamin)": ("µg", random.gauss(4, 1.2)),
                "Folate": ("µg", random.gauss(330, 80)), "Zinc": ("mg", random.gauss(9, 2)),
                "Potassium": ("mg", random.gauss(2700, 450)), "Completed": ("", 1 if random.random() < .88 else 0)}
        for n, (u, v) in nutr.items():
            con.execute("INSERT INTO nut_daily VALUES (?,?,?,?)", (d.isoformat(), n, u, max(0, round(v, 1))))
        con.execute("INSERT INTO nut_servings (date, food) VALUES (?, 'Comida')", (d.isoformat(),))
        if i >= 45:
            con.execute("INSERT INTO supplements VALUES (?, 'creatina', 5, '5 g', 'cronometer')", (d.isoformat(),))
    con.execute("INSERT INTO lifestyle VALUES (?,?,?)", (d.isoformat(), "Alcohol", "true" if alcohol else "false"))
    con.execute("INSERT INTO lifestyle VALUES (?,?,?)", (d.isoformat(), "Cafeína por la tarde", "true" if random.random() < .3 else "false"))
    plan = {1: [("HIIT", "hiit", 45, 7, 85)], 3: [("HIIT", "hiit", 45, 7, 85)],
            0: [("Fuerza", "strength_training", 50, 6, 45), ("Cinta", "treadmill_running", 25, 4, 30)],
            2: [("Fuerza", "strength_training", 50, 6, 45), ("Bici", "indoor_cycling", 30, 5, 40)],
            4: [("Movilidad" if i % 14 < 7 else "Fuerza", "strength_training", 40, 5, 35)], 5: [("Caminar", "walking", 70, 3, 25)]}.get(wd, [])
    for cat, tk, mins, rpe, load in plan:
        con.execute("INSERT INTO activities (id,date,start_local,name,type_key,category,duration_s,avg_hr,max_hr,kcal,"
                    "aerobic_te,anaerobic_te,load,rpe,z1_s,z2_s,z3_s,z4_s,z5_s,im_moderate,im_vigorous) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (aid, d.isoformat(), f"{d}T20:00:00", cat, tk, cat, mins * 60, 130, 165, mins * 7,
                     2.8, 2.0 if cat == "HIIT" else 0.5, load * random.uniform(.8, 1.2), rpe,
                     mins * 6, mins * 15, mins * 20, mins * 15 if cat == "HIIT" else 2, mins * 4 if cat == "HIIT" else 0,
                     mins // 2, mins // 3 if cat == "HIIT" else 0))
        aid += 1
DEMO_CONFIG = {"habits": [{"key": "pantallas_noche", "label": "Pantallas antes de dormir"}],
               "metrics": [{"key": "peso", "label": "Peso", "unit": "kg"}, {"key": "proteina", "label": "Proteína", "unit": "g"},
                           {"key": "kcal", "label": "Kcal ingeridas", "unit": "kcal"}, {"key": "agua", "label": "Agua", "unit": "L"},
                           {"key": "dolor", "label": "Dolor", "unit": "0–10"}]}
print(export(con, ROOT / "dashboard" / "demo.js", "GARMIN_DEMO", app_config=DEMO_CONFIG, creatina=analyse(con)))
