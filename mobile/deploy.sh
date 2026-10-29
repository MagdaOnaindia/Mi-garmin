#!/bin/bash
# Primer despliegue de la app del móvil en Fly.io (o redespliegue si ya existe).
# Crea mobile/.secrets con la contraseña y el token si no existen.
set -e
cd "$(dirname "$0")"
APP="$(sed -n 's/^app = "\(.*\)"/\1/p' fly.toml)"
FLY="$(command -v fly || command -v flyctl || echo "$HOME/.fly/bin/flyctl")"

if ! "$FLY" apps list --json | grep -q "\"Name\": *\"$APP\""; then
  "$FLY" apps create "$APP"
fi
if ! "$FLY" volumes list --app "$APP" --json | grep -q '"garmin_data"'; then
  "$FLY" volumes create garmin_data --app "$APP" --region cdg --size 1 --yes
fi

if [ ! -f .secrets ]; then
  rnd() { LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c "$1"; }
  PASS="$(rnd 5)-$(rnd 5)-$(rnd 5)"
  umask 077
  cat > .secrets <<S
# Mi Garmin (móvil). No compartas este archivo.
FLY_URL=https://$APP.fly.dev
APP_PASSWORD=$PASS
UPLOAD_TOKEN=$(rnd 40)
SESSION_SECRET=$(rnd 48)
S
fi
set -a; . ./.secrets; set +a
"$FLY" secrets set --app "$APP" --stage APP_PASSWORD="$APP_PASSWORD" UPLOAD_TOKEN="$UPLOAD_TOKEN" SESSION_SECRET="$SESSION_SECRET"
# El servidor sincroniza con Garmin: copia sync/ y nutrition/ al contexto de la imagen
rm -rf _py && mkdir _py && cp -R ../sync ../nutrition _py/
"$FLY" deploy --app "$APP" --ha=false
rm -rf _py
echo "✓ Desplegada en $FLY_URL"
