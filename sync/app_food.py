"""Importa lo que registras en la pestaña Comida de la app del móvil (Mi Garmin) a garmin.db.

Lo usa garmin_sync.py en cada sincronización:
1. download(): baja /api/food/export a data/food_export.json (si falla la red, se usa la última copia).
2. import_app_food(con): suma los alimentos de cada día y los guarda en las mismas tablas que Cronometer
   (nut_daily con los nombres de Cronometer, nut_servings y supplements), así el dashboard y el
   análisis de creatina las leen igual.

Sin duplicar: si un día ya tiene datos de Cronometer, manda Cronometer y ese día de la app se ignora.
Los días de la app llevan en nut_daily una fila nutrient='Source', unit='app' para reconocerlos.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXPORT = ROOT / "data" / "food_export.json"

# clave de la app -> (nombre en Cronometer, unidad). Mismas unidades en los dos lados.
NAMES = {
    "kcal": ("Energy", "kcal"), "prot": ("Protein", "g"), "carb": ("Carbs", "g"), "fat": ("Fat", "g"),
    "fib": ("Fiber", "g"), "sug": ("Sugars", "g"), "sat": ("Saturated", "g"), "mono": ("Monounsaturated", "g"),
    "poly": ("Polyunsaturated", "g"), "o3": ("Omega-3", "g"), "chol": ("Cholesterol", "mg"), "na": ("Sodium", "mg"),
    "k": ("Potassium", "mg"), "ca": ("Calcium", "mg"), "fe": ("Iron", "mg"), "mg": ("Magnesium", "mg"),
    "p": ("Phosphorus", "mg"), "zn": ("Zinc", "mg"), "cu": ("Copper", "mg"), "mn": ("Manganese", "mg"),
    "se": ("Selenium", "µg"), "vita": ("Vitamin A", "µg"), "vitc": ("Vitamin C", "mg"), "vitd": ("Vitamin D", "µg"),
    "vite": ("Vitamin E", "mg"), "vitk": ("Vitamin K", "µg"), "b1": ("B1 (Thiamine)", "mg"),
    "b2": ("B2 (Riboflavin)", "mg"), "b3": ("B3 (Niacin)", "mg"), "b5": ("B5 (Pantothenic Acid)", "mg"),
    "b6": ("B6 (Pyridoxine)", "mg"), "fol": ("Folate", "µg"), "b12": ("B12 (Cobalamin)", "µg"),
    "chl": ("Choline", "mg"), "water": ("Water", "g"), "caf": ("Caffeine", "mg"),
}


def download():
    """Guarda la exportación de la app. Usa la URL y el token de mobile/.secrets, como push.py."""
    sys.path.insert(0, str(ROOT / "mobile"))
    from push import curl, secrets
    s = secrets()
    raw = curl("-H", f"Authorization: Bearer {s['UPLOAD_TOKEN']}", f"{s['FLY_URL'].rstrip('/')}/api/food/export")
    json.loads(raw)  # solo guardar si es JSON válido
    tmp = EXPORT.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(EXPORT)


def import_app_food(con, path: Path = EXPORT) -> int:
    """Devuelve cuántos días de la app se cargaron (los días con Cronometer no cuentan)."""
    try:
        entries = json.loads(Path(path).read_text(encoding="utf-8")).get("entries", [])
    except (FileNotFoundError, OSError, ValueError):
        return 0
    sys.path.insert(0, str(ROOT / "nutrition"))
    from cronometer_import import SCHEMA, SUPPLEMENTS
    con.executescript(SCHEMA)

    # Quitar lo cargado antes desde la app (se recarga entero cada vez)
    old = [r[0] for r in con.execute("SELECT DISTINCT date FROM nut_daily WHERE nutrient='Source' AND unit='app'")]
    con.executemany("DELETE FROM nut_daily WHERE date=?", [(d,) for d in old])
    con.execute("DELETE FROM nut_servings WHERE category='app'")
    con.execute("DELETE FROM supplements WHERE source='app'")
    cronometer_days = {r[0] for r in con.execute("SELECT DISTINCT date FROM nut_daily")}

    by_day = defaultdict(list)
    for e in entries:
        if e.get("date") and e["date"] not in cronometer_days:
            by_day[e["date"]].append(e)
    for d, items in by_day.items():
        tot = defaultdict(float)
        for e in items:
            nut = e.get("nut") or {}
            for k, v in nut.items():
                if k in NAMES and isinstance(v, (int, float)):
                    tot[k] += v
            name = e.get("name") or ""
            amount = f"{e.get('qty', '')} {e.get('pn', '')}".strip()
            con.execute("INSERT INTO nut_servings VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (d, (e.get("ts") or "")[11:16], e.get("meal"), name, amount, "app",
                         nut.get("kcal"), nut.get("prot"), nut.get("carb"), nut.get("fat"),
                         json.dumps(nut, ensure_ascii=False)))
            for sup, pat in SUPPLEMENTS.items():
                if pat.search(name):
                    grams = e.get("qty") if (e.get("pn") or "").strip().lower() in ("g", "gramos") else None
                    con.execute("INSERT INTO supplements VALUES (?,?,?,?,'app')", (d, sup, grams, amount))
        for k, v in tot.items():
            n, u = NAMES[k]
            con.execute("INSERT OR REPLACE INTO nut_daily VALUES (?,?,?,?)", (d, n, u, round(v, 2)))
        con.execute("INSERT OR REPLACE INTO nut_daily VALUES (?,?,?,?)", (d, "Source", "app", 1))
    con.commit()
    return len(by_day)
