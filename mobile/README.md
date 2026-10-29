# Mi Garmin en el iPhone

El mismo panel, adaptado al móvil y servido desde Fly.io con contraseña.

## Cómo funciona
- `server.js` (Node, sin dependencias) sirve la app y guarda los datos en un volumen de Fly (`/data`).
- El Mac sigue siendo el que habla con Garmin. Tras cada sincronización, `push.py` sube `dashboard/data.js` a la app
  y se trae lo que registres desde el móvil: los ánimos a `data/animo.csv` (el sync ya lo lee) y los hábitos y medidas
  (peso, proteína, calorías, agua, dolor... editables desde la app) a `data/app_log.csv` (`date,kind,key,value,ts`)
  y `data/app_config.json`. El almacén único de todo sigue siendo `data/garmin.db` en el Mac.
- `install_push.sh` deja eso automático: se lanza cuando cambia `dashboard/data.js` y además a las 09:15 y 22:15.

## Sincronización en el servidor (desde 2026-10)
El servidor de Fly es el que habla con Garmin, sin depender del Mac: `server.js` lanza `sync/cloud_sync.py` cada 30 min
y cuando pulsas actualizar en la app (como mucho una vez cada 5 min). Hace lo que antes hacían `garmin_sync.py` y `push.py`
en el Mac y guarda todo en el volumen, en `/data/garmin/` (`garmin.db`, `dashboard/data.js`...). La base buena es la del servidor.
- Token de Garmin: sesión propia del servidor, aparte de la del Mac. Se crea con `uv run mobile/garmin_token_servidor.py`
  (pide tu contraseña de Garmin en la Terminal y lo guarda como secreto `GARMIN_TOKENS` en Fly). Si Garmin falla 3 veces
  seguidas, la app te manda un aviso; normalmente basta con repetir ese comando.
- El Mac solo guarda una copia: `copia_mac.py` (programado con `install_copia.sh`, cada 30 min) baja `data/garmin.db` y
  `dashboard/data.js`. `copia_mac.py --estado` dice cómo fue la última sincronización del servidor.
- Desplegar siempre con `./deploy.sh`: copia `sync/` y `nutrition/` a la imagen.
- Paso del Mac al servidor (una vez): `pasar_a_servidor.sh`. Para volver al Mac: `install_copia.sh --volver-al-mac`
  y `fly secrets unset -a mi-garmin-magda CLOUD_SYNC`.
- Sin el secreto `CLOUD_SYNC=1` el servidor no sincroniza y el Mac sigue como antes.

## Actualizar desde el móvil (antes, con el Mac)
En Hoy, "Actualizar desde Garmin" deja una petición en la app (como mucho una cada 10 minutos, para que Garmin no corte con 429).
El Mac la recoge en menos de un minuto (`sync_poll.py`, programado con `install_syncpoll.sh`), ejecuta `sync/garmin_sync.py`
y `push.py`, y avisa a la app; el móvil recarga solo los datos. Solo funciona con el Mac encendido y sin dormir.
Registro en `data/syncpoll.log`.

## Recordatorio diario
En la pestaña Registro, "Activar recordatorio" (desde el icono de la pantalla de inicio, no desde Safari; iOS 16.4 o posterior).
A las 22:00 (hora de Madrid) el servidor manda un aviso si ese día no hay ánimo, hábitos ni medidas apuntados. Por eso la
máquina de Fly está siempre encendida (`min_machines_running = 1`). Para cambiar la hora:
`fly secrets set -a mi-garmin-magda REMIND_AT=21:30`. En el reloj: Garmin Connect › Dispositivo › Notificaciones › permitir Mi Garmin.

## Archivos
| Archivo | Para qué |
|---|---|
| `deploy.sh` | Crea la app y el volumen en Fly.io (región París, `cdg`: Fly ya no tiene Madrid), genera la contraseña y los tokens en `.secrets` y despliega. |
| `.secrets` | URL, contraseña de la app y token de subida. No lo compartas. |
| `push.py` | Sube el panel y baja los ánimos. `uv run ~/Projects/Garmin/mobile/push.py` |
| `install_push.sh` | Programa `push.py`. `--uninstall` para quitarlo. Registro en `data/push.log`. |
| `sync_poll.py` | Cada minuto mira si pediste actualizar desde el móvil; si es así, sincroniza con Garmin y sube el panel. |
| `install_syncpoll.sh` | Programa `sync_poll.py` (launchd, cada 60 s). `--uninstall` para quitarlo. |
| `copia_mac.py` / `install_copia.sh` | Copia de la base y el panel del servidor al Mac, cada 30 min. |
| `garmin_token_servidor.py` | Crea la sesión de Garmin del servidor (secreto `GARMIN_TOKENS`). |
| `pasar_a_servidor.sh` | Paso único de la sincronización del Mac al servidor, con copias de seguridad. |
| `public/` | La app: `index.html`, icono, manifiesto y service worker (abre sin conexión con lo último guardado). |

## En el iPhone
1. Abre la URL de `.secrets` en Safari.
2. Compartir › Añadir a pantalla de inicio.
3. Abre el icono "Mi Garmin" y escribe la contraseña de `.secrets` (dentro de la app, no en Safari: la sesión dura un año).

## Cambiar la contraseña o cerrar todas las sesiones
```bash
fly secrets set -a mi-garmin-magda APP_PASSWORD='nueva'      # y actualízala en .secrets
fly secrets set -a mi-garmin-magda SESSION_SECRET="$(openssl rand -hex 24)"   # cierra todas las sesiones
```
