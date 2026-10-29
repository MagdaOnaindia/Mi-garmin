# Apuntar lo que Magdalena cuenta que ha comido (para Claude)

Ella dicta o escribe desde el móvil algo como "desayuno: un vaso de leche Lacturale con dos
cucharadas de ColaCao y dos tostadas de pan Oroweat con aguacate". Claude lo apunta en la
pestaña Comida de Mi Garmin sin hacerle preguntas salvo que de verdad no se pueda adivinar.

## Primero: el conector "Mi Garmin Comida"

Si en la conversación están las herramientas del conector (`buscar_alimentos`, `ver_dia`,
`apuntar`, `borrar_entradas`, `crear_alimento`, `buscar_codigo_barras`, `apuntar_agua`), usa
SIEMPRE esas: escriben directo en la app (https://mi-garmin-magda.fly.dev/comida/mcp), no
necesitan el Mac encendido y sí pueden borrar. Mismo criterio de cantidades y respuesta de abajo;
`ver_dia` da totales, objetivos y micros bajos. La vía del Mac (lo que sigue) es solo el plan B.

## Plan B: desde el Mac

Todo se hace en el Mac (carpeta conectada `~/Projects/Garmin`, en la VM `$HOME/mnt/Garmin`).
Ni la nube ni la VM llegan a la app; se escribe un archivo y el Mac lo sube.

## Pasos

1. **Buscar** cada cosa (varias de una vez):
   `cd $HOME/mnt/Garmin/comida && python3 apuntar.py buscar "leche lacturale" "colacao" "pan oroweat" "aguacate"`
   Salen id, marca, grupo, macros y raciones. Prefiere **sus productos** (ids `m-` y `c-`, y los
   creados en la app, que vienen en `estado.json`) frente a los genéricos `b-` cuando la marca o el
   producto encajan. Si nombra una marca que no está, usa el genérico más parecido y díselo.
2. **Decidir cantidad y ración** con criterio (abajo). Usa una ración con nombre si existe
   ("vaso", "rebanada", "cacito", "unidad"); si no, gramos o ml.
3. **Apuntar** (primero con `--prueba` si dudas):
   ```
   python3 apuntar.py apuntar '[{"fid": "m-lacturale-leche-desnatada-sin-lactosa", "cantidad": 1, "porcion": "vaso", "comida": "desayuno"},
                               {"fid": "m-colacao-colacao-original", "cantidad": 2, "porcion": "cucharada colmada"}]'
   ```
   Opciones: `--fecha AAAA-MM-DD` (si habla de ayer), `--agua 500` (ml bebidos, se suman).
   `comida`: desayuno, comida, merienda, cena, picoteo, suplementos. Si no la dice, la del momento
   del día (hora de Madrid) o la que pegue con lo que cuenta; los suplementos van a "suplementos".
4. **Responder** en 2-4 líneas: qué has apuntado (cantidades que has supuesto), lo que suma y el
   total del día que imprime el script. Nada de tablas largas.

## Cantidades por defecto (si no las dice)

- "Un vaso" de leche 250 ml; "un café con leche" 150 ml de leche; "una taza" 200 ml.
- Tostada / rebanada de pan de molde 1 rebanada (~30-35 g); de pan de barra 40 g.
- Aceite: "un chorrito" 1 cucharada (10 ml); en ensalada o tostada 1 cucharada.
- Aguacate: medio 70 g. Plátano 1 unidad 120 g sin piel. Manzana 150 g.
- Huevo 1 unidad 50 g. Yogur 1 envase (125 g, o el de la ración del producto).
- Plato de pasta o arroz cocido 200 g; de legumbre cocida 250 g; ensalada 150 g de verdura.
- Filete de pollo o pescado 150 g; "una lata" de atún/bonito la ración "lata".
- Colágeno 1 cacito; magnesio 1 dosis; omega-3 1 cápsula; Olistic 1 dosis diaria.
- "Un poco" = media ración; "mucho" o "un platazo" = ración y media.
Si da cantidades aproximadas ("unos 100 g"), úsalas tal cual.

## Corregir

- `python3 apuntar.py dia` (o `dia 2026-10-07`) enseña lo apuntado con su `[id]`.
- Para cambiar una cantidad, vuelve a apuntar con el mismo `"id"` y la cantidad nueva: la sustituye.
- Para borrar algo, que lo quite ella en la app (deslizar o tocar el alimento); el Mac no puede borrar.

## Cuándo aparece en la app

- Con el vigilante instalado (`bash ~/Projects/Garmin/comida/instalar_apuntar.sh`, una vez):
  segundos después, si el Mac está encendido. Si la app de Fly estaba dormida tarda un poco más.
- Sin él, o con el Mac apagado: en la siguiente subida (9:15 / 22:15, o cuando se encienda).
- `estado.json` (lo apuntado en la app y los alimentos creados allí) se refresca en cada subida
  y cada 15 minutos con el vigilante; `dia` avisa de hasta cuándo está al día.

Producto que no existe y del que manda foto de la etiqueta: ver `NUEVO_ALIMENTO.md`.
