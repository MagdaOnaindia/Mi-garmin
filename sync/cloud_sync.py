"""Sincronización en el servidor de Fly: la lanza server.js cada 30 min y cuando pides actualizar desde el móvil.

Hace lo mismo que el Mac hacía con garmin_sync.py + push.py, pero sin el Mac:
  1. push.py --pull      baja de la propia app los ánimos, hábitos, medidas y objetivos
  2. garmin_sync.py      trae Garmin a data/garmin.db y regenera dashboard/data.js
                         (1 día hacia atrás normalmente; 3 días si la última vez completa fue hace más de 6 h)
  3. push.py --push      sube data.js a la app
  4. Copia coherente de la base (data/garmin-copia.db) para que el Mac la descargue (mobile/copia_mac.py).

En el servidor, ROOT/data es /data/garmin (volumen) y el token de Garmin vive en GARMINTOKENS
(/data/garmin/.garminconnect). La primera vez lo copia del secreto GARMIN_TOKENS de Fly, y vuelve
a copiarlo si el secreto cambia (cuando renuevas el token desde el Mac).
Estado de la última vez en data/cloud_sync.json. Sale con 3 si aún no se ha subido la base inicial.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DB = DATA / "garmin.db"
COPY = DATA / "garmin-copia.db"
STATE = DATA / "cloud_sync.json"
FULL_EVERY = 6 * 3600


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def install_token():
    """Escribe el token del secreto GARMIN_TOKENS en GARMINTOKENS si es nuevo o ha cambiado."""
    secret, store = os.environ.get("GARMIN_TOKENS", "").strip(), os.environ.get("GARMINTOKENS")
    if not secret or not store:
        return
    h = hashlib.sha256(secret.encode()).hexdigest()
    if not secret.startswith("{"):  # garmin_token_servidor.py lo guarda en base64
        secret = base64.b64decode(secret).decode()
    d = Path(store)
    mark = d / ".secreto.sha256"
    if mark.exists() and mark.read_text().strip() == h:
        return  # ya instalado; Garmin lo va renovando en el volumen
    json.loads(secret)  # que sea JSON válido antes de pisar nada
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    f = d / "garmin_tokens.json"
    tmp = d / ".garmin_tokens.json.nuevo"
    tmp.write_text(secret)
    tmp.chmod(0o600)
    tmp.replace(f)
    mark.write_text(h)
    log("Token de Garmin instalado desde el secreto")


def run(args, timeout):
    r = subprocess.run([sys.executable, *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    out = (r.stdout + r.stderr).strip()
    if out:
        print(out[-6000:], flush=True)
    return r.returncode, out


def snapshot_db():
    tmp = COPY.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    src, dst = sqlite3.connect(DB), sqlite3.connect(tmp)
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    tmp.replace(COPY)


def main():
    if not DB.exists():
        print("Aún no está la base inicial (data/garmin.db). Súbela desde el Mac: uv run mobile/copia_mac.py --subir-inicial")
        return 3
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    full = "--full" in sys.argv or time.time() - state.get("last_full_ts", 0) > FULL_EVERY
    lookback = 3 if full else 1
    started = time.time()
    state.update(last_start=datetime.now().isoformat(timespec="seconds"), running=True)
    STATE.write_text(json.dumps(state))
    ok, err = True, None
    try:
        install_token()
    except Exception as e:
        log("No pude instalar el token:", e)

    code, out = run(["mobile/push.py", "--pull"], 300)
    if code:
        log("Aviso: no se bajaron los registros de la app (sigo)")
    log(f"Garmin: {lookback} día(s) hacia atrás")
    try:
        code, out = run(["sync/garmin_sync.py", "--lookback", str(lookback)], 900)
        if code:
            ok, err = False, (out.splitlines() or [f"código {code}"])[-1][:200]
    except subprocess.TimeoutExpired:
        ok, err = False, "garmin_sync tardó más de 15 minutos"
    try:  # aviso diario de salud (data/aviso_salud.json); si falla, el sync sigue
        code, out = run(["sync/aviso_salud.py"], 120)
        if code:
            log("Aviso de salud no calculado:", (out.splitlines() or [f"código {code}"])[-1][:200])
    except Exception as e:
        log("Aviso de salud no calculado:", e)
    code, out = run(["mobile/push.py", "--push"], 300)
    if code and ok:
        ok, err = False, "No se pudo subir el panel a la app"
    try:
        snapshot_db()
    except Exception as e:
        log("Aviso: no pude copiar la base para el Mac:", e)

    state.update(running=False, last_end=datetime.now().isoformat(timespec="seconds"), ok=ok, error=err,
                 lookback=lookback, seconds=round(time.time() - started))
    if ok and full:
        state["last_full_ts"] = started
    STATE.write_text(json.dumps(state))
    log("Hecho" if ok else f"Con errores: {err}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
