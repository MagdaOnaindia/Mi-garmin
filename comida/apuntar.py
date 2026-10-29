#!/usr/bin/env python3
"""Apuntar en la pestaña Comida lo que Magdalena le cuenta a Claude (ver APUNTAR_COMIDA.md).

  python3 apuntar.py buscar "colacao" "pan oroweat"   → candidatos con id, marca y raciones
  python3 apuntar.py ver m-colacao-colacao-original   → raciones y macros de un alimento
  python3 apuntar.py apuntar '[{"fid": "...", "cantidad": 250, "porcion": "ml", "comida": "desayuno"}]'
        [--fecha 2026-10-08] [--agua 500] [--prueba]
  python3 apuntar.py dia [2026-10-08]                  → lo apuntado ese día y los totales

`apuntar` escribe nuevos/registro-<fecha>-<hora>.json; subir_nuevos.py lo sube a la app
(al momento si el vigilante de instalar_apuntar.sh está puesto, si no a las 9:15 / 22:15).
Si un elemento lleva "id" de una entrada ya apuntada, la sustituye (para corregir cantidades).
"""
import json
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
NUEVOS = HERE / "nuevos"
FOODS = HERE.parent / "mobile" / "comida" / "public" / "foods.json"
ESTADO = HERE / "estado.json"  # lo deja subir_nuevos.py: alimentos creados en la app y lo apuntado
MEALS = ["desayuno", "comida", "merienda", "cena", "snacks", "suplementos"]
MEAL_LABEL = {"snacks": "picoteo"}

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Madrid")
except Exception:  # sin base de zonas horarias: hora de verano peninsular
    TZ = timezone(timedelta(hours=2))


def now():
    return datetime.now(TZ)


def norm(s):
    s = unicodedata.normalize("NFD", str(s or "").lower())
    return re.sub(r"[^a-z0-9 ]+", " ", "".join(c for c in s if unicodedata.category(c) != "Mn"))


def read_json(p, default):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return default


def foods():
    out = {f["id"]: f for f in read_json(FOODS, {"foods": []})["foods"]}
    for f in read_json(ESTADO, {}).get("custom", []):
        out[f["id"]] = f
    # alimentos de foto que aún no han vuelto en estado.json
    for p in sorted(NUEVOS.glob("*.json")) + sorted(NUEVOS.glob("subidos/*.json")):
        d = read_json(p, None)
        if isinstance(d, dict) and "registro" in d:
            continue
        for f in (d if isinstance(d, list) else [d] if isinstance(d, dict) else []):
            if f.get("id") and f.get("nut") and f["id"] not in out:
                f.setdefault("g", "Mis alimentos")
                f.setdefault("pt", [{"n": "g", "f": 0.01}])
                out[f["id"]] = f
    return out


def per_portion(f, k, pf):
    return f["nut"].get(k, 0) * pf


def describe(f):
    pts = "; ".join(f"{p['n']} = {per_portion(f, 'kcal', p['f']):.0f} kcal" for p in f.get("pt") or [])
    n100 = f["nut"]
    return (f"{f['id']}  |  {f['n']}" + (f" ({f['brand']})" if f.get("brand") else "") + f"  [{f.get('g', '')}]\n"
            f"    por {f.get('base', '100 g')}: {n100.get('kcal', 0):.0f} kcal, {n100.get('prot', 0):.1f} g prot, "
            f"{n100.get('carb', 0):.1f} g hc, {n100.get('fat', 0):.1f} g grasa\n    raciones: {pts}")


def search(q, db, limit=8):
    toks = [t for t in norm(q).split() if len(t) > 1]
    scored = []
    for f in db.values():
        name, brand, group = norm(f["n"]), norm(f.get("brand")), norm(f.get("g"))
        words = (name + " " + brand).split()
        s = 0
        for t in toks:
            if t in words:
                s += 3
            elif any(w.startswith(t) or (len(t) > 3 and t[:-1] == w[:len(t) - 1]) for w in words):
                s += 2  # plurales y prefijos: "huevos" ~ "huevo"
            elif t in name + " " + brand:
                s += 1
            elif t in group:
                s += 0.5
        if s:
            s += 1 if not f["id"].startswith("b-") else 0  # sus productos primero
            scored.append((s, f))
    scored.sort(key=lambda x: (-x[0], len(x[1]["n"])))
    return [f for _, f in scored[:limit]]


def guess_meal(f, t):
    if f.get("g") == "Suplementos":
        return "suplementos"
    h = t.hour + t.minute / 60
    return "desayuno" if h < 11.5 else "comida" if h < 16.5 else "merienda" if h < 19.5 else "cena"


def pick_portion(f, name):
    pts = f.get("pt") or [{"n": "ración", "f": 1}]
    if not name:
        return next((p for p in pts if p["n"] in ("g", "ml")), pts[0])
    n = norm(name).strip()
    for test in (lambda p: norm(p["n"]).strip() == n, lambda p: norm(p["n"]).startswith(n), lambda p: n in norm(p["n"])):
        hit = [p for p in pts if test(p)]
        if hit:
            return hit[0]
    if n in ("g", "gramos", "ml") and f.get("base") in ("100 g", "100 ml"):
        return {"n": "ml" if "ml" in f["base"] else "g", "f": 0.01}
    raise ValueError(f"'{f['n']}' no tiene la ración '{name}'. Raciones: " + ", ".join(p["n"] for p in pts))


def free_stamp(date, t):
    # nombre de archivo (e ids) que no choquen con otro apuntado en el mismo segundo
    base, n = t.strftime("%H%M%S"), 0
    while True:
        stamp = base + (f"{n}" if n else "")
        if not any((d / f"registro-{date}-{stamp}.json").exists() for d in (NUEVOS, NUEVOS / "subidos")):
            return stamp
        n += 1


def build(items, date, stamp, t):
    db, out = foods(), []
    for i, it in enumerate(items, 1):
        f = db.get(it.get("fid"))
        if not f:
            raise ValueError(f"No encuentro el alimento {it.get('fid')!r}; usa 'buscar' primero")
        p = pick_portion(f, it.get("porcion"))
        qty = float(it.get("cantidad", 1))
        if not 0 < qty < 1e5:
            raise ValueError(f"Cantidad rara para {f['n']}: {qty}")
        meal = it.get("comida") or guess_meal(f, t)
        meal = {"picoteo": "snacks", "snack": "snacks", "suplemento": "suplementos"}.get(meal, meal)
        if meal not in MEALS:
            raise ValueError(f"Comida '{meal}' no válida: " + ", ".join(MEALS))
        mul = p["f"] * qty
        eid = it.get("id") or f"v{date.replace('-', '')}-{stamp}-{i:02d}"
        if not re.fullmatch(r"[a-z0-9-]{6,40}", eid):
            raise ValueError(f"id no válido: {eid}")
        out.append({"id": eid, "date": it.get("fecha") or date, "meal": meal, "fid": f["id"], "name": f["n"],
                    "brand": f.get("brand", ""), "qty": round(qty, 3), "pn": p["n"], "f": p["f"],
                    "nut": {k: round(v * mul, 4) for k, v in f["nut"].items() if isinstance(v, (int, float))}})
    return out


def totals(entries):
    t = {k: 0.0 for k in ("kcal", "prot", "carb", "fat")}
    for e in entries:
        for k in t:
            t[k] += e["nut"].get(k, 0) or 0
    return f"{t['kcal']:.0f} kcal · {t['prot']:.0f} g proteína · {t['carb']:.0f} g hidratos · {t['fat']:.0f} g grasa"


def show(entries):
    for m in MEALS:
        es = [e for e in entries if e["meal"] == m]
        if es:
            print(f"  {MEAL_LABEL.get(m, m).capitalize()}:")
            for e in es:
                qty = f"{e['qty']:g} {e['pn']}"
                print(f"    {e['name']}" + (f" ({e['brand']})" if e.get("brand") else "") +
                      f" · {qty} · {e['nut'].get('kcal', 0):.0f} kcal, {e['nut'].get('prot', 0):.1f} g prot   [{e['id']}]")


def day_entries(date):
    est = read_json(ESTADO, {})
    by_id = {e["id"]: e for e in est.get("entries", []) if e.get("date") == date}
    pend = []
    for p in sorted(NUEVOS.glob("registro-*.json")) + sorted(NUEVOS.glob("subidos/registro-*.json")):
        d = read_json(p, {})
        for e in d.get("registro", []):
            if e.get("date") == date and (e["id"] not in by_id or p.parent == NUEVOS):
                by_id[e["id"]] = e
                if p.parent == NUEVOS:
                    pend.append(e["id"])
    return list(by_id.values()), pend, est.get("fecha_estado")


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, args = argv[1], argv[2:]
    if cmd == "buscar":
        db = foods()
        for q in args:
            print(f"### {q}")
            hits = search(q, db)
            print("\n".join(describe(f) for f in hits) if hits else "    (nada; busca con otras palabras o crea el alimento con NUEVO_ALIMENTO.md)")
        return 0
    if cmd == "ver":
        db = foods()
        for fid in args:
            print(describe(db[fid]) if fid in db else f"No existe {fid}")
        return 0
    if cmd == "dia":
        date = args[0] if args else now().strftime("%Y-%m-%d")
        es, pend, fe = day_entries(date)
        print(f"{date}: {len(es)} alimentos" + (f" ({len(pend)} pendientes de subir)" if pend else ""))
        show(es)
        print("  Total: " + totals(es))
        if fe:
            print(f"  (lo apuntado en la app está al día hasta {fe})")
        return 0
    if cmd == "apuntar":
        opts, rest, i = {}, [], 0
        while i < len(args):
            if args[i] in ("--fecha", "--agua"):
                opts[args[i][2:]] = args[i + 1]
                i += 2
            elif args[i] == "--prueba":
                opts["prueba"] = True
                i += 1
            else:
                rest.append(args[i])
                i += 1
        raw = sys.stdin.read() if not rest or rest[0] == "-" else rest[0]
        items = json.loads(raw) if raw.strip() else []
        items = items if isinstance(items, list) else [items]
        t = now()
        date = opts.get("fecha") or t.strftime("%Y-%m-%d")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise ValueError("fecha AAAA-MM-DD")
        stamp = free_stamp(date, t)
        entries = build(items, date, stamp, t)
        agua = int(float(opts["agua"])) if opts.get("agua") else 0
        if not entries and not agua:
            print("Nada que apuntar")
            return 1
        show(entries)
        if entries:
            print("  Esto suma: " + totals(entries))
        if agua:
            print(f"  Agua: +{agua} ml")
        if opts.get("prueba"):
            print("  (prueba: no se ha guardado)")
            return 0
        NUEVOS.mkdir(exist_ok=True)
        body = {"registro": entries}
        if agua:
            body["agua_add_ml"] = agua
            body["fecha"] = date
        name = f"registro-{date}-{stamp}"
        tmp = NUEVOS / f".{name}.tmp"
        tmp.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        tmp.rename(NUEVOS / f"{name}.json")
        es, _, _ = day_entries(date)
        print(f"  Guardado ({name}.json). Total del día con esto: " + totals(es))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)
