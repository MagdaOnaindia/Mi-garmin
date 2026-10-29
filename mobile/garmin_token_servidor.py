# /// script
# requires-python = ">=3.10"
# dependencies = ["garminconnect==0.3.17"]
# ///
"""Crea una sesión de Garmin propia para el servidor de Fly y la guarda como secreto GARMIN_TOKENS.

Ejecútalo tú en la Terminal del Mac (pide tu correo y contraseña de Garmin, y el código si tienes verificación en dos pasos):
    uv run ~/Projects/Garmin/mobile/garmin_token_servidor.py

Es una sesión aparte de la del Mac (~/.garminconnect, la del conector de Claude Desktop): así, cuando una
se renueva, la otra no deja de valer. Nada se guarda en disco: el token va directo a Fly.
Si alguna vez el servidor avisa de que no puede entrar en Garmin, vuelve a ejecutarlo.
Inicia sesión una sola vez: repetirlo muchas veces seguidas hace que Garmin bloquee un rato (429).
"""
import base64
import getpass
import shutil
import subprocess
import sys
from pathlib import Path

from garminconnect import Garmin

APP = "mi-garmin-magda"
FLY = shutil.which("fly") or shutil.which("flyctl") or str(Path.home() / ".fly/bin/flyctl")

email = input("Correo de Garmin: ").strip()
password = getpass.getpass("Contraseña de Garmin (no se ve al escribir): ")
g = Garmin(email, password, prompt_mfa=lambda: input("Código de verificación de Garmin: ").strip())
g.login()
print(f"✓ Sesión iniciada como {g.get_full_name()}")
tokens = base64.b64encode(g.client.dumps().encode()).decode()  # base64: sin comillas que Fly pueda tocar
stage = "--stage" in sys.argv  # para dejarlo preparado sin reiniciar la app
r = subprocess.run([FLY, "secrets", "import", "--app", APP, *(["--stage"] if stage else [])],
                   input=f"GARMIN_TOKENS={tokens}\n", text=True)
if r.returncode:
    sys.exit("No se pudo guardar el secreto en Fly (¿fly auth login?)")
print("✓ Token guardado en Fly" + (" (se aplicará en el próximo despliegue)" if stage else ""))
