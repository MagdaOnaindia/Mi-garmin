# /// script
# requires-python = ">=3.10"
# ///
"""Sube el panel a la app del móvil y baja los ánimos registrados desde el iPhone.

1. Descarga los ánimos guardados en la app y los añade a data/animo.csv (sin duplicar),
   que el sync del Mac ya lee en cada sincronización.
2. Descarga los hábitos y medidas de la app a data/app_log.csv (copia completa: date,kind,key,value,ts)
   y la lista de hábitos y medidas a data/app_config.json.
3. Sube dashboard/data.js a la app.

Uso: uv run ~/Projects/Garmin/mobile/push.py [--pull | --push]
  --pull solo baja (pasos 1 y 2), --push solo sube (paso 3).
Lee la URL y el token de mobile/.secrets (lo crea el despliegue), o de las variables FLY_URL y UPLOAD_TOKEN
(así lo usa el servidor de Fly, en sync/cloud_sync.py).
"""
import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SECRETS = HERE / ".secrets"
DATA_JS = ROOT / "dashboard" / "data.js"
MOOD_CSV = ROOT / "data" / "animo.csv"
LOG_CSV = ROOT / "data" / "app_log.csv"
CONFIG_JSON = ROOT / "data" / "app_config.json"
LOCK = ROOT / "data" / "push.lock"


def secrets():
    if os.environ.get("FLY_URL") and os.environ.get("UPLOAD_TOKEN"):
        return {"FLY_URL": os.environ["FLY_URL"], "UPLOAD_TOKEN": os.environ["UPLOAD_TOKEN"]}
    out = {}
    for line in SECRETS.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def curl(*args):
    r = subprocess.run(["curl", "-sS", "--fail-with-body", "--max-time", "60", *args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout


def pull_moods(url, token):
    entries = json.loads(curl("-H", f"Authorization: Bearer {token}", f"{url}/api/mood/export"))
    have = set()
    if MOOD_CSV.exists():
        have = {l.split(",", 1)[0].strip() for l in MOOD_CSV.read_text(encoding="utf-8").splitlines()}
    new = [e for e in entries if e["ts"] not in have]
    if new:
        MOOD_CSV.parent.mkdir(parents=True, exist_ok=True)
        text = MOOD_CSV.read_text(encoding="utf-8") if MOOD_CSV.exists() else ""
        if text and not text.endswith("\n"):
            text += "\n"
        text += "".join(
            f"{e['ts']},{e['mood']},{e['energy'] if e['energy'] is not None else ''},{e['note'] or ''}\n" for e in new
        )
        MOOD_CSV.write_text(text, encoding="utf-8")
    print(f"  {len(new)} ánimos nuevos desde el móvil")


def pull_log(url, token):
    d = json.loads(curl("-H", f"Authorization: Bearer {token}", f"{url}/api/log/export"))
    rows = sorted(d["entries"], key=lambda e: (e["date"], e["kind"], e["key"]))
    LOG_CSV.parent.mkdir(parents=True, exist_ok=True)
    tmp = LOG_CSV.with_suffix(".tmp")
    tmp.write_text("date,kind,key,value,ts\n" + "".join(
        f"{e['date']},{e['kind']},{e['key']},{e['value']},{e['ts']}\n" for e in rows), encoding="utf-8")
    tmp.replace(LOG_CSV)
    cfg = d["config"]
    # Objetivos de la app v2 (pasos, sueño...): se guardan en Entreno; el sync los lee de aquí
    try:
        goals = json.loads(curl("-H", f"Authorization: Bearer {token}", f"{url}/api/train/export")).get("settings", {}).get("goals") or {}
        if goals:
            cfg["goals"] = goals
            if goals.get("steps"):
                cfg["step_goal"] = goals["steps"]
    except Exception as e:
        print(f"  Objetivos no leídos: {e}", file=sys.stderr)
    CONFIG_JSON.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  {len(rows)} registros de hábitos y medidas")


def push_data(url, token):
    if not DATA_JS.exists():
        print("  No hay dashboard/data.js todavía")
        return
    out = curl("-X", "POST", "-H", f"Authorization: Bearer {token}", "-H", "Content-Type: text/plain",
               "--data-binary", f"@{DATA_JS}", f"{url}/api/upload")
    print("  Panel subido:", out)


def main():
    # Si se lanza dos veces a la vez (tras el sync y desde sync_poll.py), la segunda espera:
    # así los ánimos no se duplican en animo.csv
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK, "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    s = secrets()
    url, token = s["FLY_URL"].rstrip("/"), s["UPLOAD_TOKEN"]
    ok = True
    steps = {"--pull": (pull_moods, pull_log), "--push": (push_data,)}.get(sys.argv[1] if len(sys.argv) > 1 else "",
                                                                         (pull_moods, pull_log, push_data))
    for step in steps:
        try:
            step(url, token)
        except Exception as e:  # la app puede tardar en despertar; se reintenta en la siguiente ejecución
            ok = False
            print(f"  Error en {step.__name__}: {e}", file=sys.stderr)
    nuevos = ROOT / "comida" / "subir_nuevos.py"  # alimentos nuevos para la pestaña Comida
    if nuevos.exists():
        try:
            subprocess.run([sys.executable, str(nuevos)], timeout=120)
        except Exception as e:
            print(f"  Error en subir_nuevos: {e}", file=sys.stderr)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
