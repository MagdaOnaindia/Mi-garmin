#!/usr/bin/env python3
"""Sube a Mi Garmin lo que Claude deja en comida/nuevos/*.json.

Cada archivo es un alimento (o una lista) con el formato de NUEVO_ALIMENTO.md,
o comidas apuntadas: {"registro": [entradas], "agua_ml": 1750 | "agua_add_ml": 250, "fecha": ...}
(las escribe apuntar.py). Al final baja el estado de la app a comida/estado.json (alimentos creados
en la app y lo apuntado en los últimos 21 días) para que Claude lo vea.
Usa la URL y el token de mobile/.secrets. Lo que se sube pasa a nuevos/subidos/;
si la app está dormida o falla, se queda en nuevos/ y se reintenta la próxima vez.
Se ejecuta con push.py (9:15 y 22:15), al momento con el vigilante de instalar_apuntar.sh,
o a mano: python3 comida/subir_nuevos.py
"""
import fcntl
import json
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
NUEVOS = HERE / "nuevos"
SECRETS = HERE.parent / "mobile" / ".secrets"
ESTADO = HERE / "estado.json"


def secrets():
    out = {}
    for line in SECRETS.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def post(url, token, path, body=None):
    # el token va por stdin (-H @-), no en la línea de comandos; sin body es un GET
    args = ["curl", "-sS", "--fail-with-body", "--max-time", "60", "-H", "@-"]
    if body is not None:
        args += ["-X", "POST", "-H", "Content-Type: application/json", "--data-binary", json.dumps(body)]
    r = subprocess.run([*args, f"{url}{path}"], input=f"Authorization: Bearer {token}\n", capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return json.loads(r.stdout)


def save_estado(url, token):
    d = post(url, token, "/api/food/export")
    desde = (date.today() - timedelta(days=21)).isoformat()
    est = {"fecha_estado": datetime.now().strftime("%Y-%m-%d %H:%M"), "custom": d.get("custom", []),
           "goals": d.get("goals", {}), "entries": [e for e in d.get("entries", []) if e.get("date", "") >= desde]}
    tmp = ESTADO.with_suffix(".tmp")
    tmp.write_text(json.dumps(est, ensure_ascii=False), encoding="utf-8")
    tmp.rename(ESTADO)


def main():
    lock = open(HERE / ".subir.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX)  # el vigilante y push.py pueden coincidir
    files = sorted(NUEVOS.glob("*.json")) if NUEVOS.exists() else []
    s = secrets()
    url, token = s["FLY_URL"].rstrip("/"), s["UPLOAD_TOKEN"]
    if not files:
        print("  0 alimentos nuevos")
    (NUEVOS / "subidos").mkdir(parents=True, exist_ok=True)
    ok = True
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))  # falla si el archivo está a medio escribir
            if isinstance(data, dict) and "registro" in data:
                es = data["registro"]
                for i in range(0, len(es), 50):  # la app acepta hasta 60 por envío
                    post(url, token, "/api/food/log", es[i:i + 50])
                day = data.get("fecha") or (es[0]["date"] if es else None)
                if data.get("agua_ml") and day:
                    post(url, token, "/api/food/water", {"date": day, "min_l": data["agua_ml"] / 1000})
                if data.get("agua_add_ml") and day:
                    post(url, token, "/api/food/water", {"date": day, "add_ml": data["agua_add_ml"]})
                agua = data.get("agua_ml") or data.get("agua_add_ml")
                msg = f"Apuntado: {len(es)} alimentos" + (f" y {agua} ml de agua" if agua else "")
            else:
                foods = data if isinstance(data, list) else [data]
                names = []
                for i in range(0, len(foods), 50):  # la app acepta 50 por envío
                    names += [x["n"] for x in post(url, token, "/api/food/custom", foods[i:i + 50])]
                msg = "Alimento subido: " + ", ".join(names)
            f.rename(NUEVOS / "subidos" / f.name)
            print(f"  {msg}")
        except Exception as e:
            ok = False
            print(f"  Error con {f.name}: {e}", file=sys.stderr)
    try:
        save_estado(url, token)
    except Exception as e:
        print(f"  No pude bajar el estado de la app: {e}", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
