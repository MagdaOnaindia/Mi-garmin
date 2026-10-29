# Deduce los nutrientes de tus alimentos de Cronometer (marcas, recetas) a partir de los totales por comida.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import csv, re, sys, json, collections
import numpy as np
from scipy.optimize import nnls
from nutrients import N
import sr28
D = sys.argv[1]; SR = sys.argv[2]; OUT = sys.argv[3]
rows = sr28.load(SR+'/ABBREV.txt', SR+'/FOOD_DES.txt')
def sr(rx):
    m = sr28.find(rows, rx); assert m, rx; return m[0]
daily = list(csv.DictReader(open(D+'/dailysummary.csv', encoding='utf-8-sig')))
serv = list(csv.DictReader(open(D+'/servings.csv', encoding='utf-8-sig')))

def parse_amount(a):
    m = re.match(r'([\d.]+)\s*(?:x\s*)?(.*)', a.strip())
    q, u = float(m.group(1)), m.group(2).strip()
    m2 = re.match(r'([\d.]+)\s+(.*)', u)          # "2.50 x 100.0 ml" -> q=2.5*100, u=ml
    if 'x' in a and m2: q, u = q*float(m2.group(1)), m2.group(2)
    return q, u

# Alias: mismo alimento en varios idiomas
ALIAS = {
 'Basmati-Reis, in ungesalzenem Wasser gekocht':'Arroz basmati, cocido en agua sin sal',
 'Basmati Rice, Cooked in Unsalted Water':'Arroz basmati, cocido en agua sin sal',
 'Avocado, schwarze Schale':'Aguacate Hass','Avocado, Black Skin':'Aguacate Hass',
 'Greek Yogurt, Plain, Nonfat':'Yogur griego natural desnatado',
 'Chia Seeds':'Semillas de chía','Kiwi Fruit, Green':'Kiwi verde',
}
# Previos genéricos: (regex SR28, gramos por unidad escrita)
PRIOR = {
 ('Pechuga de pollo, sin piel antes de cocinar','g'):(r'^Chicken, broilers or fryers, breast, meat only, cooked, roasted$',1),
 ('Arroz basmati, cocido en agua sin sal','g'):(r'^Rice, white, long-grain, regular, unenriched, cooked without salt$',1),
 ('Garbanzos en conserva, escurridos y enjuagados','g'):(r'^Chickpeas .*canned, drained, rinsed',1),
 ('Tomate crudo, incluidos tomate cherry, tomate uva y tomate roma','g'):(r'^Tomatoes, red, ripe, raw, year round average$',1),
 ('Aguacate Hass','g'):(r'^Avocados, raw, California$',1),
 ('Cebolla blanca, amarilla o roja, cruda','g'):(r'^Onions, raw$',1),
 ('Yogur griego natural desnatado','g'):(r'^Yogurt, Greek, plain, nonfat$',1),
 ('Semillas de chía','g'):(r'^Seeds, chia seeds, dried$',1),
 ('Kiwi SunGold','each'):(r'^Kiwifruit, ZESPRI SunGold, raw$',81),
 ('Kiwi verde','each - 2" diameter'):(r'^Kiwifruit, green, raw$',69),
 ('Copos de avena, tradicionales o rápidos, secos','g'):(r'^Cereals, oats, regular and quick, not fortified, dry$',1),
 ('Platano','g'):(r'^Bananas, raw$',1),
 ('Espinaca cruda','g'):(r'^Spinach, raw$',1),
 ('Pak Choi','g'):(r'^Cabbage, chinese \(pak-choi\), raw$',1),
 ('Eggs, Cooked','large'):(r'^Egg, whole, cooked, hard-boiled$',50),
 ('Gambas cocidas congeladas','g'):(r'^Crustaceans, shrimp, cooked \(not previously frozen\)$',1),
 ('Patata asada, sin piel','g'):(r'^Potatoes, baked, flesh, without salt$',1),
 ('Horse Meat','g'):(r'^Game meat, horse, raw$',1),
 ('Salmón rojo (sockeye) de Alaska, crudo','g'):(r'^Fish, salmon, sockeye, raw$',1),
 ('La Española, Aceite de Oliva Virgen Extra','ml'):(r'^Oil, olive, salad or cooking$',0.91),
 ('Bonito del norte cocido','g'):(r'^Fish, tuna, white, canned in water, drained solids$',1),
 ('Lacturale, Leche UHT Desnatada','ml'):(r'^Milk, nonfat, fluid, with added vitamin A and vitamin D',1.03),
}
ZERO = {'Agua'}
def nutvec(r):
    out = []
    for k,_,_,_,col,_,_ in N:
        if col is None: out.append(np.nan); continue
        v = r.get(col, '')
        v = float(v) if v not in ('', None) else np.nan
        if k == 'vitd' and not np.isnan(v): v /= 40
        out.append(v)
    return np.array(out)
meals = collections.defaultdict(list)
for x in serv:
    name = ALIAS.get(x['Food Name'], x['Food Name'])
    if name in ZERO: continue
    q, u = parse_amount(x['Amount'])
    if q == 0: continue
    meals[(x['Day'], x['Group'])].append((name, u, q))
tot = {(d['Date'], d['Group']): nutvec(d) for d in daily if d['Group'] != 'Total'}
keys = [k for k in meals if k in tot]
vars_ = sorted({(n,u) for k in keys for n,u,_ in meals[k]})
idx = {v:i for i,v in enumerate(vars_)}
A = np.zeros((len(keys), len(vars_)))
for r,k in enumerate(keys):
    for n,u,q in meals[k]: A[r, idx[(n,u)]] += q
B = np.array([tot[k] for k in keys])
X = np.full((len(vars_), len(N)), np.nan)
for j,(key,*_ ) in enumerate(N):
    if N[j][4] is None: continue
    b = B[:, j]; ok = ~np.isnan(b)
    if ok.sum() == 0: continue
    scale = max(np.nanmean(np.abs(b[ok])), 1e-6)
    rowsA = [A[ok]/scale]; rowsB = [b[ok]/scale]
    for v,i in idx.items():
        e = np.zeros(len(vars_)); 
        if v in PRIOR:
            rx, gpu = PRIOR[v]; pv = sr(rx)['nut'].get(key)
            colsum = A[ok, i].mean() if A[ok, i].any() else 1
            if pv is not None:
                w = 1.0  # fuerza del previo (≈ 1 comida típica)
                e[i] = w*colsum/scale; rowsA.append(e[None]); rowsB.append(np.array([w*colsum*pv*gpu/100/scale]))
                continue
        e[i] = 1e-3*A[ok, i].mean()/scale if A[ok,i].any() else 1e-3
        rowsA.append(e[None]); rowsB.append(np.zeros(1))
    xs, _ = nnls(np.vstack(rowsA), np.concatenate(rowsB), maxiter=5000)
    X[:, j] = xs
# Calidad: cuántas comidas contienen cada variable y error de ajuste en kcal
jk = 0
pred = A @ X[:, jk]; err = np.abs(pred - B[:, jk])
print('Error medio kcal por comida: %.1f (máx %.1f)' % (err.mean(), err.max()))
res = []
for v,i in idx.items():
    n = int((A[:, i] > 0).sum())
    nut = {N[j][0]: round(float(X[i, j]), 5) for j in range(len(N)) if not np.isnan(X[i, j])}
    res.append({'name': v[0], 'unit': v[1], 'n_meals': n, 'prior': v in PRIOR, 'per_unit': nut})
    print(f"{n:3d} {'P' if v in PRIOR else ' '} {v[0][:45]:45s} [{v[1]}] kcal/u={nut.get('kcal',0):.3f} prot={nut.get('prot',0):.3f} ca={nut.get('ca',0):.2f} fe={nut.get('fe',0):.3f}")
json.dump(res, open(OUT, 'w'), ensure_ascii=False, indent=1)
