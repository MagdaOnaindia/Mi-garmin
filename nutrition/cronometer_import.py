"""Importa las exportaciones CSV de Cronometer a data/garmin.db.

Uso (desde la Terminal del Mac, solo necesita Python 3):
    python3 ~/Projects/Garmin/nutrition/cronometer_import.py

Busca los CSV que exporta Cronometer (web › Ajustes › Cuenta › Exportar datos) en:
    ~/Projects/Garmin/data/cronometer/
    iCloud Drive › Garmin › cronometer/   (lo más cómodo desde el iPhone)
    ~/Downloads/
Reconoce cada archivo por su cabecera, así que el nombre da igual
(dailysummary.csv, servings (3).csv...). Si dos exportaciones cubren el mismo día,
gana la más reciente. Se puede ejecutar todas las veces que quieras.

Tablas que crea:
    nut_daily      (date, nutrient, unit, value)   todos los nutrientes del día, formato largo
    nut_day        (date, kcal, protein_g, ...)    vista con los macros principales
    nut_servings   (date, time, meal, food, amount, category, kcal, protein_g, carbs_g, fat_g, nutrients)
    nut_biometrics (date, time, metric, unit, value)   peso, etc. si lo registras en Cronometer
    supplements    (date, supplement, amount_g, amount_raw)   creatina y otros suplementos detectados
"""
from __future__ import annotations

import csv
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "garmin.db"
FOLDERS = [
    ROOT / "data" / "cronometer",
    Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Garmin/cronometer",
    Path.home() / "Downloads",
]

# Nombre interno -> patrón de alimento en Cronometer. Añade aquí otros suplementos.
SUPPLEMENTS = {
    "creatina": re.compile(r"creatin", re.I),
    "colageno": re.compile(r"col[aá]geno|collagen", re.I),
    "magnesio": re.compile(r"magnesi", re.I),
    "omega3": re.compile(r"omega.?3|fish oil", re.I),
    "olistic": re.compile(r"olistic", re.I),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS nut_daily (
  date TEXT, nutrient TEXT, unit TEXT, value REAL, PRIMARY KEY (date, nutrient)
);
CREATE TABLE IF NOT EXISTS nut_servings (
  date TEXT, time TEXT, meal TEXT, food TEXT, amount TEXT, category TEXT,
  kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL, nutrients TEXT
);
CREATE TABLE IF NOT EXISTS nut_biometrics (
  date TEXT, time TEXT, metric TEXT, unit TEXT, value REAL
);
CREATE TABLE IF NOT EXISTS supplements (
  date TEXT, supplement TEXT, amount_g REAL, amount_raw TEXT, source TEXT
);
CREATE INDEX IF NOT EXISTS nut_servings_date ON nut_servings(date);
DROP VIEW IF EXISTS nut_day;
CREATE VIEW nut_day AS
SELECT date,
  max(CASE WHEN nutrient='Energy' THEN value END)    AS kcal,
  max(CASE WHEN nutrient='Protein' THEN value END)   AS protein_g,
  max(CASE WHEN nutrient='Carbs' THEN value END)     AS carbs_g,
  max(CASE WHEN nutrient='Net Carbs' THEN value END) AS net_carbs_g,
  max(CASE WHEN nutrient='Fat' THEN value END)       AS fat_g,
  max(CASE WHEN nutrient='Fiber' THEN value END)     AS fiber_g,
  max(CASE WHEN nutrient='Sugars' THEN value END)    AS sugars_g,
  max(CASE WHEN nutrient='Water' THEN value END)     AS water_g,
  max(CASE WHEN nutrient='Caffeine' THEN value END)  AS caffeine_mg,
  max(CASE WHEN nutrient='Alcohol' THEN value END)   AS alcohol_g,
  -- Cronometer solo marca "Completed" si cierras el día a mano. Se da por completo
  -- también si pasa de 1200 kcal (un día a medio registrar queda por debajo).
  CASE WHEN max(CASE WHEN nutrient='Completed' THEN value END) = 1
         OR max(CASE WHEN nutrient='Energy' THEN value END) >= 1200 THEN 1 ELSE 0 END AS completed,
  max(CASE WHEN nutrient='Completed' THEN value END) AS completed_marked
FROM nut_daily GROUP BY date;
"""

UNIT_RE = re.compile(r"^(.*?)\s*\(([^()]*)\)\s*$")


def split_unit(col: str):
    """'Protein (g)' -> ('Protein', 'g'); 'B1 (Thiamine) (mg)' -> ('B1 (Thiamine)', 'mg')."""
    m = UNIT_RE.match(col.strip())
    return (m.group(1).strip(), m.group(2).strip()) if m else (col.strip(), "")


def num(x):
    if x is None:
        return None
    x = str(x).strip().replace(",", ".")
    if x.lower() in ("true", "yes"):
        return 1.0
    if x.lower() in ("false", "no"):
        return 0.0
    try:
        return float(x)
    except ValueError:
        return None


def grams(amount: str):
    """'5.00 g' -> 5; '5000 mg' -> 5; '1 scoop' -> None (se guarda igual como tomada)."""
    m = re.match(r"\s*([\d.,]+)\s*(mg|g|gram|grams|gramos)\b", amount or "", re.I)
    if not m:
        return None
    v = float(m.group(1).replace(",", "."))
    return v / 1000 if m.group(2).lower() == "mg" else v


def kind(header: list[str]) -> str | None:
    h = [c.strip().lower() for c in header]
    if "food name" in h:
        return "servings"
    if "metric" in h and "amount" in h:
        return "biometrics"
    if "exercise" in h:
        return "exercises"
    if "note" in h:
        return "notes"
    if h and h[0] == "date" and any(c.startswith("energy") for c in h):
        return "daily"
    return None


def find_files():
    files = []
    for folder in FOLDERS:
        try:
            for f in folder.glob("*.csv"):
                try:
                    with f.open(encoding="utf-8-sig", newline="") as fh:
                        header = next(csv.reader(fh), [])
                except (OSError, UnicodeDecodeError):
                    continue
                k = kind(header)
                if k in ("daily", "servings", "biometrics"):
                    files.append((f.stat().st_mtime, k, f))
        except (PermissionError, OSError):
            continue  # p. ej. Descargas sin permiso desde launchd
    return sorted(files)  # la más antigua primero: la más reciente sobrescribe


def rows_of(f: Path):
    with f.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def load_daily(con, rows):
    # Las exportaciones nuevas traen una fila por comida (columna Group) y otra "Total".
    if rows and "Group" in rows[0]:
        rows = [r for r in rows if (r.get("Group") or "").strip().lower() == "total"]
    dates = {r.get("Date", "")[:10] for r in rows if r.get("Date")}
    con.executemany("DELETE FROM nut_daily WHERE date=?", [(d,) for d in dates])
    for r in rows:
        d = (r.get("Date") or "")[:10]
        if not d:
            continue
        for col, val in r.items():
            if col is None or col in ("Date", "Group"):
                continue
            v = num(val)
            if v is None:
                continue
            name, unit = split_unit(col)
            con.execute("INSERT OR REPLACE INTO nut_daily VALUES (?,?,?,?)", (d, name, unit, v))
    return len(dates)


def load_servings(con, rows):
    dates = {r.get("Day", "")[:10] for r in rows if r.get("Day")}
    for d in dates:
        con.execute("DELETE FROM nut_servings WHERE date=?", (d,))
        con.execute("DELETE FROM supplements WHERE date=? AND source='cronometer'", (d,))
    for r in rows:
        d = (r.get("Day") or "")[:10]
        if not d:
            continue
        nutrients = {}
        for col, val in r.items():
            if col in (None, "Day", "Time", "Group", "Food Name", "Amount", "Category"):
                continue
            v = num(val)
            if v is not None:
                nutrients[split_unit(col)[0]] = v
        food = r.get("Food Name") or ""
        con.execute(
            "INSERT INTO nut_servings VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (d, r.get("Time"), r.get("Group"), food, r.get("Amount"), r.get("Category"),
             nutrients.get("Energy"), nutrients.get("Protein"), nutrients.get("Carbs"),
             nutrients.get("Fat"), json.dumps(nutrients, ensure_ascii=False)),
        )
        for name, pat in SUPPLEMENTS.items():
            if pat.search(food):
                con.execute("INSERT INTO supplements VALUES (?,?,?,?,'cronometer')",
                            (d, name, grams(r.get("Amount")), r.get("Amount")))
    return len(dates)


def load_biometrics(con, rows):
    dates = {r.get("Day", "")[:10] for r in rows if r.get("Day")}
    con.executemany("DELETE FROM nut_biometrics WHERE date=?", [(d,) for d in dates])
    for r in rows:
        d = (r.get("Day") or "")[:10]
        v = num(r.get("Amount"))
        if d and v is not None:
            con.execute("INSERT INTO nut_biometrics VALUES (?,?,?,?,?)",
                        (d, r.get("Time"), r.get("Metric"), r.get("Unit"), v))
    return len(dates)


def import_cronometer(con) -> dict:
    """Punto de entrada para garmin_sync.py. Devuelve cuántos días cargó de cada tipo."""
    con.executescript(SCHEMA)
    loaders = {"daily": load_daily, "servings": load_servings, "biometrics": load_biometrics}
    done = {}
    for _, k, f in find_files():
        try:
            n = loaders[k](con, rows_of(f))
        except (OSError, csv.Error) as e:
            print(f"  ! No pude leer {f.name}: {e}", file=sys.stderr)
            continue
        done[k] = done.get(k, 0) + n
    con.commit()
    return done


def main():
    con = sqlite3.connect(DB)
    done = import_cronometer(con)
    if not done:
        print("No encontré exportaciones de Cronometer en:")
        for f in FOLDERS:
            print(f"  {f}")
        return
    span = con.execute("SELECT min(date), max(date), count(*) FROM nut_day").fetchone()
    crea = con.execute("SELECT count(DISTINCT date), round(avg(amount_g),1) FROM supplements "
                       "WHERE supplement='creatina'").fetchone()
    print(f"✓ Cronometer: {span[2]} días de nutrición ({span[0]} → {span[1]})")
    print(f"  Archivos: " + ", ".join(f"{k} ({n} días)" for k, n in done.items()))
    print(f"  Creatina registrada: {crea[0]} días" + (f", media {crea[1]} g" if crea[1] else ""))


if __name__ == "__main__":
    main()
