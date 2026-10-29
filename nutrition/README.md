# Nutrición (Cronometer) y creatina

## Cómo traer los datos de Cronometer
1. Entra en **cronometer.com** (desde el Mac o desde Safari en el iPhone) › Ajustes › Cuenta › **Exportar datos**.
2. Descarga al menos **Daily Nutrition** (`dailysummary.csv`) y **Servings** (`servings.csv`). Si te pesas en Cronometer, añade **Biometrics**. Elige "todo el historial" la primera vez; después basta con el último mes.
3. Guarda los archivos en cualquiera de estas carpetas (el nombre da igual):
   - `~/Projects/Garmin/data/cronometer/`
   - iCloud Drive › Garmin › cronometer (lo más cómodo desde el iPhone)
   - Descargas
4. Ejecuta `python3 ~/Projects/Garmin/nutrition/cronometer_import.py`.

Puedes repetirlo cuando quieras: si dos exportaciones cubren el mismo día, gana la más reciente.

## Creatina
Regístrala en Cronometer como un alimento más ("Creatine Monohydrate", 5 g). El importador la detecta por el nombre y la guarda en la tabla `supplements`. Para otros suplementos, añade una línea en `SUPPLEMENTS` dentro de `cronometer_import.py`.

`python3 ~/Projects/Garmin/nutrition/creatina.py` compara tus periodos **con la creatina saturada** (≥ 20 tomas en 28 días) con los periodos **sin creatina** (ninguna toma en 35 días). Las semanas de carga y de lavado se excluyen, porque el músculo tarda ~3–4 semanas en saturarse y otras 4–6 en volver a su nivel. También corrige por fase del ciclo y necesita al menos 14 días en cada estado.

Qué esperar según los estudios:
- **Peso:** sube 0,5–1,5 kg en las primeras semanas por agua dentro del músculo. No es grasa. En mujeres el aumento suele ser menor que en hombres.
- **Fuerza y volumen de entrenamiento:** mejora pequeña pero consistente en fuerza máxima y repeticiones. Para verla hace falta registrar cargas o el esfuerzo percibido.
- **VFC, FC en reposo, sueño:** no hay efecto consistente. Si aparece algo, probablemente es otra cosa que cambió a la vez.
- **Ánimo y energía mental:** hay estudios con señales positivas, sobre todo en mujeres y con falta de sueño, pero la evidencia es menos firme.

Para un resultado limpio: 4–6 semanas sin creatina, luego 3–5 g al día sin parar, sin cambiar otras cosas a la vez.

## Tablas en `data/garmin.db`
| Tabla | Qué contiene |
|---|---|
| `nut_daily` | Todos los nutrientes de cada día (formato largo: fecha, nutriente, unidad, valor) |
| `nut_day` | Vista con kcal, proteína, carbohidratos, grasa, fibra, azúcar, agua, cafeína, alcohol |
| `nut_servings` | Cada alimento registrado, con su comida y sus nutrientes |
| `nut_biometrics` | Peso u otras medidas registradas en Cronometer |
| `supplements` | Creatina y otros suplementos detectados |
