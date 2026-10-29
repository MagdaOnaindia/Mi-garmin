# Añadir un alimento nuevo desde una foto (para Claude)

Magdalena manda la foto de la etiqueta (y si puede, del frontal con la marca). Claude:

1. **Lee la etiqueta** y pasa todo **por 100 g** (o 100 ml). Si la tabla viene por ración, divide.
   Sal → sodio: `na (mg) = sal (g) × 400`.
2. **Busca los micros** que la etiqueta no trae:
   - producto conocido: ficha del fabricante, Open Food Facts por código de barras;
   - si no: el equivalente genérico en USDA (`comida/basics.txt`, `sr28.py`) ajustado a sus macros.
   Pon en `src` de dónde sale cada cosa, p. ej. `"etiqueta + USDA (micros aprox.)"`.
3. **Escribe** `comida/nuevos/<id>.json` en el Mac (carpeta conectada). Escribe primero a un `.tmp` y renómbralo a `.json`.
4. Dile que aparecerá en **Alimentos → Mis alimentos** tras la próxima subida (9:15 / 22:15),
   o al momento si ejecuta `python3 ~/Projects/Garmin/comida/subir_nuevos.py`.

## Formato

```json
{
  "id": "c-hsn-colageno-limon",
  "n": "Colágeno hidrolizado limón",
  "brand": "HSN",
  "g": "Mis alimentos",
  "src": "etiqueta + Open Food Facts",
  "base": "100 g",
  "code": "8436...",
  "pt": [{ "n": "cacito (10 g)", "f": 0.1 }],
  "nut": { "kcal": 360, "prot": 90, "carb": 0, "fat": 0, "na": 200 }
}
```

- `id`: `c-` + minúsculas, números y guiones. Mismo id = actualiza el alimento.
- `pt`: raciones; `f` = gramos de la ración / 100.
- `nut` (por 100 g), claves válidas: kcal, prot, carb, fat, fib, sug, sat, mono, poly, o3 (g), chol, na, k, ca, fe, mg, p, zn, cu, mn (mg), se (µg), vita (µg RAE), vitc (mg), vitd (µg), vite (mg), vitk (µg), b1, b2, b3, b5, b6 (mg), fol (µg), b12 (µg), chl (mg), water (g), caf (mg). Las que no sepas, omítelas (no pongas 0).
