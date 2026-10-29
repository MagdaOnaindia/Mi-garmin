# Metodología: qué mide el dashboard y con qué reglas

Este archivo resume las reglas que usa `sync/export_dashboard.py`. Cada regla remite a la ficha donde está la evidencia. Son **herramientas de orientación**, no diagnósticos: si algo te preocupa (dolor, mareos, cambios fuertes en el ciclo), consulta con un profesional sanitario.

## Principios
1. **Te comparamos contigo misma.** La VFC, la FC en reposo o el sueño varían mucho entre personas. Lo que importa es tu línea base y tu tendencia, no los valores de otras mujeres.
2. **Tendencia mejor que dato suelto.** Una mala noche no significa nada; tres o cuatro días seguidos por debajo de tu rango, sí.
3. **Respeto a la fase de calibración.** Durante las primeras semanas muchas métricas aparecen como "pendiente". Es intencionado.

| Métrica | Datos mínimos | Ficha |
|---|---|---|
| VFC nocturna, media 7 días | 4 noches en la última semana | [01](01-vfc-y-fc-reposo.md) |
| Línea base VFC propia (60 días, media ± DE) | 14 noches | [01](01-vfc-y-fc-reposo.md) |
| Rango VFC "equilibrado" de Garmin | ~3 semanas de sueño con el reloj | [01](01-vfc-y-fc-reposo.md) |
| FC en reposo frente a tu media de 30 días | 7 días | [01](01-vfc-y-fc-reposo.md) |
| Ratio carga aguda:crónica (7 d / 28 d) | 21 días | [03](03-carga-de-entrenamiento.md) |
| Carga por RPE de sesión (sRPE) | Desde la primera sesión, si valoras el esfuerzo en el reloj | [03](03-carga-de-entrenamiento.md) |
| Medias por fase del ciclo | 1 ciclo completo; fiable con 3 o más | [02](02-ciclo-menstrual.md) |

## Semáforo diario (heurística propia)
Se puntúa cada componente disponible con verde = 2, ámbar = 1 y rojo = 0, y se hace la media.

| Componente | Verde | Ámbar | Rojo |
|---|---|---|---|
| VFC anoche (frente al rango de Garmin, o a tu media − 1 DE si aún no hay rango) | dentro o por encima | hasta un 10 % por debajo (o entre −1 y −2 DE) | por debajo de eso |
| FC en reposo frente a tu media de 30 días | hasta +2 lpm | +3 a +5 lpm | más de +5 lpm |
| Horas de sueño | ≥ 7 h | 6 a 7 h | < 6 h |
| Body Battery al despertar | ≥ 50 | 25 a 49 | < 25 |

Resultado: media ≥ 1,6 verde; ≥ 1 ámbar; resto rojo.

**Cómo usarlo con tu semana:**
- **Verde:** plan normal. Martes/jueves, tabata a tope; el resto, fuerza con progresión.
- **Ámbar:** entrena, pero baja un escalón: menos series en la fuerza, o más descanso entre bloques del tabata. Cardio suave (zona 2) en lugar de intervalos.
- **Rojo:** caminar, movilidad y la rutina de psoas/cadera/lumbar. Si se repite 3 días o más, revisamos sueño, estrés y carga.

Los umbrales están elegidos con criterio práctico a partir de la literatura de las fichas, no validados como tal en un estudio. Los ajustaremos con tus datos reales.
