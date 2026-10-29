# /// script
# requires-python = ">=3.10"
# ///
"""Desde que el servidor de Fly sincroniza con Garmin, el Mac solo guarda una copia.

  uv run ~/Projects/Garmin/mobile/copia_mac.py                  # baja garmin.db y dashboard/data.js del servidor
  uv run ~/Projects/Garmin/mobile/copia_mac.py --subir-inicial  # una sola vez: sube la base del Mac al servidor
  uv run ~/Projects/Garmin/mobile/copia_mac.py --estado         # cómo fue la última sincronización del servidor

La copia la programa install_copia.sh (cada 30 min mientras el Mac está encendido). Cualquier cambio que
hagas a data/garmin.db en el Mac se pierde en la siguiente copia: la base buena es la del servidor.
Usa la URL y el token de mobile/.secrets.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DB = ROOT / "data" / "garmin.db"
DATA_JS = ROOT / "dashboard" / "data.js"
MOOD_CSV = ROOT / "data" / "animo.csv"


def secrets():
    out = {}
    for line in (HERE / ".secrets").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out["FLY_URL"].rstrip("/"), out["UPLOAD_TOKEN"]


def curl(url, token, path, *args, timeout=120):
    # el token va por stdin (-H @-), no en la línea de comandos
    r = subprocess.run(["curl", "-sS", "--fail-with-body", "--max-time", str(timeout), "-H", "@-", *args, f"{url}{path}"],
                       input=f"Authorization: Bearer {token}\n", capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout


def download(url, token, path, dest: Path, check):
    fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=f".{dest.name}.")
    os.close(fd)
    try:
        curl(url, token, path, "-o", tmp)
        check(Path(tmp))
        os.replace(tmp, dest)
    finally:
        Path(tmp).unlink(missing_ok=True)


def check_db(p: Path):
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    n = con.execute("SELECT count(*) FROM daily").fetchone()[0]
    con.close()
    if not n:
        raise RuntimeError("la copia del servidor viene vacía; no piso la del Mac")


def check_js(p: Path):
    if not p.read_text(encoding="utf-8")[:200].lstrip().startswith("window.GARMIN_DATA"):
        raise RuntimeError("data.js del servidor no tiene el formato esperado")


def bajar():
    url, token = secrets()
    DB.parent.mkdir(exist_ok=True)
    DATA_JS.parent.mkdir(exist_ok=True)
    download(url, token, "/api/cloud/db", DB, check_db)
    download(url, token, "/api/cloud/datajs", DATA_JS, check_js)
    st = json.loads(curl(url, token, "/api/cloud/status")).get("last") or {}
    print(f"✓ Copia del servidor (última sincronización {st.get('last_end', '?')}, {'bien' if st.get('ok') else 'con errores: ' + str(st.get('error'))})")


def subir_inicial():
    url, token = secrets()
    with tempfile.TemporaryDirectory() as d:
        snap = Path(d) / "garmin.db"
        src, dst = sqlite3.connect(DB), sqlite3.connect(snap)  # copia coherente aunque algo esté escribiendo
        with dst:
            src.backup(dst)
        src.close()
        dst.close()
        print(curl(url, token, "/api/cloud/seed?file=garmin.db", "-X", "POST", "-H", "Content-Type: application/octet-stream",
                   "--data-binary", f"@{snap}", timeout=600))
    if MOOD_CSV.exists():
        print(curl(url, token, "/api/cloud/seed?file=animo.csv", "-X", "POST", "-H", "Content-Type: text/plain",
                   "--data-binary", f"@{MOOD_CSV}"))


def estado():
    url, token = secrets()
    print(json.dumps(json.loads(curl(url, token, "/api/cloud/status")), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        {"--subir-inicial": subir_inicial, "--estado": estado}.get(arg, bajar)()
    except Exception as e:
        sys.exit(f"No se pudo: {e}")
