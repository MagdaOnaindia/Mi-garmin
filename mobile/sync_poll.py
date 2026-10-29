# /// script
# requires-python = ">=3.10"
# ///
"""Sincroniza con Garmin cuando lo pides desde el móvil ("Actualizar desde Garmin" en la pestaña Hoy).

El token de Garmin solo vive en el Mac, así que el móvil deja una petición en la app y este script
(lanzado cada minuto por launchd, ver install_syncpoll.sh) la recoge:
  1. GET  /api/sync/pending  → ¿hay petición?
  2. uv run sync/garmin_sync.py (lo mismo que la sincronización de las 09:00 y 22:00)
  3. uv run mobile/push.py    (sube el panel nuevo y baja los registros del móvil)
  4. POST /api/sync/done      → el móvil ve que ha terminado y recarga los datos

Un candado (data/syncpoll.lock) evita que dos sincronizaciones se solapen, y si la sincronización
programada ya está en marcha, espera al minuto siguiente.
Uso: uv run ~/Projects/Garmin/mobile/sync_poll.py
"""
import fcntl
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SECRETS = Path(os.environ.get("MG_SECRETS", HERE / ".secrets"))  # MG_SECRETS solo para pruebas
LOCK = ROOT / "data" / "syncpoll.lock"
UV = shutil.which("uv") or next((p for p in ("/opt/homebrew/bin/uv", "/usr/local/bin/uv",
                                               str(Path.home() / ".local/bin/uv")) if Path(p).exists()), "uv")
# Comandos (se pueden cambiar con variables de entorno solo para probar sin llamar a Garmin)
SYNC_CMD = os.environ.get("SYNC_POLL_SYNC_CMD", f"{UV} run {ROOT}/sync/garmin_sync.py")
PUSH_CMD = os.environ.get("SYNC_POLL_PUSH_CMD", f"{UV} run {HERE}/push.py")


def secrets():
    out = {}
    for line in SECRETS.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def api(url, token, path, body=None):
    # el token va por stdin (-H @-), no en la línea de comandos
    args = ["curl", "-sS", "--fail-with-body", "--max-time", "30", "-H", "@-"]
    if body is not None:
        args += ["-X", "POST", "-H", "Content-Type: application/json", "--data-binary", json.dumps(body)]
    r = subprocess.run([*args, f"{url}{path}"], input=f"Authorization: Bearer {token}\n", capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return json.loads(r.stdout)


def log(*a):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def sync_running():
    r = subprocess.run(["pgrep", "-f", "sync/garmin_sync.py"], capture_output=True, text=True)
    return bool(r.stdout.strip())


def run(cmd, timeout):
    r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    out = (r.stdout + r.stderr).strip()
    if out:
        print(out[-4000:], flush=True)
    return r.returncode, out


def main():
    s = secrets()
    url, token = s["FLY_URL"].rstrip("/"), s["UPLOAD_TOKEN"]
    try:
        st = api(url, token, "/api/sync/pending")
    except Exception as e:  # sin conexión o la app despertando: se reintenta en un minuto, sin llenar el registro
        if "--verbose" in sys.argv:
            log("No se pudo consultar la app:", e)
        return 0
    if not st.get("pending"):
        return 0

    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK, "w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("Ya hay una sincronización en marcha (candado)")
            return 0
        if sync_running():
            log("La sincronización programada está en marcha; lo intento en el próximo minuto")
            return 0
        log(f"Petición del móvil ({st.get('requested')}): sincronizando con Garmin")
        try:
            api(url, token, "/api/sync/done", {"state": "running"})
        except Exception as e:
            log("Aviso: no pude marcar el inicio:", e)
        ok, err = True, None
        try:
            code, out = run(SYNC_CMD, 900)
            if code:
                ok, err = False, f"garmin_sync terminó con código {code}: " + (out.splitlines() or [""])[-1][:150]
        except subprocess.TimeoutExpired:
            ok, err = False, "garmin_sync tardó más de 15 minutos"
        try:  # se sube igualmente: aunque Garmin falle, baja lo apuntado en el móvil
            code, _ = run(PUSH_CMD, 300)
            if code and ok:
                ok, err = False, f"push.py terminó con código {code}"
        except subprocess.TimeoutExpired:
            ok, err = (False, "push.py tardó más de 5 minutos") if ok else (ok, err)
        try:
            api(url, token, "/api/sync/done", {"ok": ok, "error": err})
        except Exception as e:
            log("No pude avisar a la app del final:", e)
        log("Hecho" if ok else f"Con errores: {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
