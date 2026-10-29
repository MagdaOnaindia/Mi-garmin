# Comida: registro de alimentos y micronutrientes (tipo Macro)

Pestaña "Comida" dentro de Mi Garmin (https://mi-garmin-magda.fly.dev/comida), con la misma contraseña.

## Qué hace
- Diario por comidas (desayuno, comida, merienda, cena, picoteo, suplementos), con anillo de kcal y barras de proteína, carbohidratos y grasa.
- Buscador sin tildes sobre 212 alimentos: 190 básicos con macros y 30 micronutrientes (USDA SR28, nombres en español)
  y tus alimentos de Cronometer (Lacturale, Olistic, Oroweat, La Carloteña, ColaCao, AOVE La Española, bonito ahumado,
  tostada cottage pavo...), suplementos (colágeno HSN y MyProtein, magnesio y omega-3 HSN, creatina, psyllium).
- "Lo que sueles tomar" en cada comida, recientes, copiar la comida de ayer, guardar una comida como receta.
- Escáner de código de barras (Open Food Facts) y creación de alimentos con su etiqueta. Recetas con ingredientes y raciones.
- Garmin: objetivo de kcal = gasto medio de Garmin de los últimos 7 días completos ± ajuste; muestra el gasto del día,
  el balance y los entrenos. Proteína por kg (1,6 g/kg por defecto).
- Pestaña Nutrientes: día, media de 7 o 28 días frente a las ingestas recomendadas para mujer de 19 a 50 años.
- Cada cambio actualiza las medidas "kcal" y "proteina" del día, así que el panel las recibe por el camino de siempre (push.py → app_log).

## Archivos
| Archivo | Para qué |
|---|---|
| `mobile/comida/comida.js` | Rutas del servidor (/comida, /api/food/*). Datos en el volumen de Fly: food_log.json, food_custom.json, food_goals.json. |
| `mobile/comida/public/comida.html` | La app. |
| `mobile/comida/public/foods.json` | Base de alimentos generada. |
| `comida/integracion.diff` | Las 4 líneas que conectan la pestaña con `mobile/server.js`, `Dockerfile` e `index.html`. |
| `comida/build_db.py` | Regenera foods.json. Necesita los datos SR28 (paquete npm `fda-nutrient-database`, carpeta data/). |
| `comida/solve_mine.py` | Deduce los nutrientes de tus marcas y recetas a partir de los totales por comida de Cronometer (dailysummary + servings). |
| `comida/basics.txt` | Lista de básicos: nombre en español, grupo y alimento USDA. |

## Exportar al Mac
`GET /api/food/export` con `Authorization: Bearer UPLOAD_TOKEN` devuelve todos los registros con sus 36 nutrientes.

## Alimentos nuevos desde una foto
Manda a Claude la foto de la etiqueta. Claude deja el alimento en `comida/nuevos/` (ver NUEVO_ALIMENTO.md) y `subir_nuevos.py` lo sube a la app con la subida diaria, o al momento si lo ejecutas a mano.

## Apuntar comidas contándoselas a Claude

Magdalena le dice a Claude lo que ha comido (desde el móvil) y Claude lo apunta con
`apuntar.py` siguiendo `APUNTAR_COMIDA.md`. Se escribe `nuevos/registro-<fecha>-<hora>.json`
y `subir_nuevos.py` lo sube. Para que llegue en segundos y no a las 9:15 / 22:15, una vez:
`bash ~/Projects/Garmin/comida/instalar_apuntar.sh` (vigila `nuevos/`; registro en data/comida_subir.log).
`subir_nuevos.py` deja además `estado.json` con lo apuntado en la app y los alimentos creados allí.
