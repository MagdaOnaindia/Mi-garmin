FROM node:22-alpine
# Python para sincronizar con Garmin desde el servidor (sync/cloud_sync.py, lo lanza server.js)
RUN apk add --no-cache python3 py3-pip curl tzdata \
 && pip install --no-cache-dir --break-system-packages garminconnect==0.3.17 garmin-fit-sdk==21.218.0
WORKDIR /app
COPY server.js ./
COPY public ./public
COPY comida ./comida
COPY entreno.js entreno_mcp.js salud_mcp.js ./
COPY public-v2 ./public-v2
# Código de sync/ y nutrition/ (deploy.sh lo copia a _py/ antes de desplegar). Sus datos van al volumen.
COPY _py/sync /app/garmin/sync
COPY _py/nutrition /app/garmin/nutrition
COPY push.py /app/garmin/mobile/push.py
RUN ln -s /data/garmin /app/garmin/data && ln -s /data/garmin/dashboard /app/garmin/dashboard
# La sync en el servidor solo se enciende con el secreto CLOUD_SYNC=1 (lo pone pasar_a_servidor.sh)
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
