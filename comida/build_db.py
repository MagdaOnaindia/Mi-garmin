"""Genera foods.json para la app de comida: básicos (USDA SR28 con nombres en español) + tus alimentos,
marcas, suplementos y recetas (deducidos de tus comidas de Cronometer o de la etiqueta).
uso: python3 build_db.py <carpeta SR28> <basics.txt> <mine_solved.json> <servings.csv> <salida foods.json>"""
import os, sys, json, re, csv, collections, unicodedata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nutrients import N
import sr28
SR, BASICS, SOLVED, SERV, OUT = sys.argv[1:6]
rows = sr28.load(SR + '/ABBREV.txt', SR + '/FOOD_DES.txt')
def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:48]
TR = [(r'\bcups?\b', 'taza'), (r'\btbsp\b', 'cucharada'), (r'\btsp\b', 'cucharadita'), (r'\blarge\b', 'grande'),
      (r'\bmedium\b', 'mediano'), (r'\bsmall\b', 'pequeño'), (r'\bslices?\b', 'rebanada'), (r'\beach\b', 'unidad'),
      (r'\bfruit\b', 'pieza'), (r'\boz\b', 'onza'), (r'\bfl onza\b', 'onza líq.'), (r'\bwhole\b', 'entero'), (r'\bchopped\b', 'picado'),
      (r'\bsliced\b', 'en rodajas'), (r'\bpieces?\b', 'trozo'), (r'\bpackage\b', 'paquete'), (r'\bcan\b', 'lata'), (r'\bstalk\b', 'tallo'),
      (r'\bleaf\b', 'hoja'), (r'\bclove\b', 'diente'), (r'\bserving\b', 'ración'), (r'\bcontainer\b', 'envase'), (r'\bNLEA\b', '')]
def tr(d):
    for a, b in TR: d = re.sub(a, b, d, flags=re.I)
    return re.sub(r'\s+', ' ', d).strip()
def r4(x): return float('%.4g' % x)
foods = []
# 1) Básicos
for l in open(BASICS, encoding='utf-8'):
    if l.startswith('#') or not l.strip(): continue
    name, grp, rx = l.rstrip('\n').split('|', 2)
    r = sr28.find(rows, rx)[0]
    portions = [{'n': 'g', 'f': 0.01}] + [{'n': f"{tr(p['n'])} ({round(p['g'])} g)", 'f': r4(p['g'] / 100)} for p in r['portions']]
    foods.append({'id': 'b-' + slug(name), 'n': name, 'g': grp, 'src': 'USDA ' + r['ndb'], 'base': '100 g',
                  'nut': {k: r4(v) for k, v in r['nut'].items()}, 'pt': portions})
# 2) Tus alimentos
solved = {(x['name'], x['unit']): x['per_unit'] for x in json.load(open(SOLVED, encoding='utf-8'))}
serv = list(csv.DictReader(open(SERV, encoding='utf-8-sig')))
uses = collections.Counter(x['Food Name'] for x in serv)
def from_solved(name, unit, per=100):
    v = solved[(name, unit)]
    return {k: r4(x * per) for k, x in v.items() if x > 1e-6 or k in ('kcal', 'prot', 'carb', 'fat')}
def label(**kw): return {k: r4(v) for k, v in kw.items()}
G = lambda *p: [{'n': 'g', 'f': 0.01}] + [{'n': n, 'f': r4(g / 100)} for n, g in p]
U = lambda n: [{'n': n, 'f': 1}]
MINE = [
 # (nombre, marca, grupo, nutrientes, base, porciones, fuente, nombres Cronometer)
 ('Leche desnatada sin lactosa', 'Lacturale', 'Huevos y lácteos', from_solved('Lacturale, Leche UHT Desnatada', 'ml'), '100 ml',
   [{'n': 'ml', 'f': 0.01}, {'n': 'vaso (250 ml)', 'f': 2.5}, {'n': 'taza (200 ml)', 'f': 2}], 'tus comidas de Cronometer', ['Lacturale, Leche UHT Desnatada']),
 ('Hair-Nourishing for Women (vial 25 ml)', 'Olistic', 'Suplementos', from_solved('Olistic, Hair-Nourishing Supplement, For Women', 'daily dose', 1), '1 dosis',
   U('dosis diaria'), 'tus comidas de Cronometer', ['Olistic, Hair-Nourishing Supplement, For Women']),
 ('Puré Eroski (pure eroski cottage)', 'Eroski', 'Platos', from_solved('pure eroski cottage', 'g'), '100 g',
   G(('ración (200 g)', 200), ('ración grande (330 g)', 330)), 'tus comidas de Cronometer', ['pure eroski cottage']),
 ('Pan Cereales y Semillas (rebanada)', 'Oroweat', 'Cereales y pan', from_solved('Oroweat, Cereales Y Semillas Pan', 'Rebanada', 1), '1 rebanada',
   U('rebanada'), 'tus comidas de Cronometer (sin micronutrientes)', ['Oroweat, Cereales Y Semillas Pan']),
 ('Pechuga de pollo asada 99%', 'La Carloteña', 'Carne y aves', from_solved('La Carloteña, Oven Roasted Chicken Breast, 99% Chicken', 'g'), '100 g',
   G(('loncha (10 g)', 10)), 'tus comidas de Cronometer (sin micronutrientes)', ['La Carloteña, Oven Roasted Chicken Breast, 99% Chicken']),
 ('Bonito ahumado', '', 'Pescado y marisco', from_solved('Bonito ahumado', 'g'), '100 g',
   G(('lata (110 g)', 110)), 'tus comidas de Cronometer', ['Bonito ahumado']),
 ('ColaCao Original', 'ColaCao', 'Bebidas', from_solved('ColaCao, Chocolate Drink Mix, Original', 'g'), '100 g',
   G(('cucharada colmada (20 g)', 20), ('cucharada (15 g)', 15)), 'tus comidas de Cronometer', ['ColaCao, Chocolate Drink Mix, Original']),
 ('Aceite de oliva virgen extra', 'La Española', 'Grasas', from_solved('La Española, Aceite de Oliva Virgen Extra', 'ml'), '100 ml',
   [{'n': 'ml', 'f': 0.01}, {'n': 'cucharada (10 ml)', 'f': 0.1}, {'n': 'cucharadita (5 ml)', 'f': 0.05}], 'tus comidas de Cronometer', ['La Española, Aceite de Oliva Virgen Extra']),
 ('Avocado Toast', 'Sabra', 'Platos', from_solved('Sabra, Avocado Toast', 'tray', 1), '1 bandeja', U('bandeja'), 'tus comidas de Cronometer', ['Sabra, Avocado Toast']),
 ('Pan de masa madre artesanal (ración)', '', 'Cereales y pan', from_solved('Pan de masa madre artesanal, redondo', 'serving', 1), '1 ración', U('ración'),
   'tus comidas de Cronometer (sin micronutrientes)', ['Pan de masa madre artesanal, redondo']),
 # Etiquetas (aproximadas: corrígelas escaneando el código de barras o editando)
 ('Colágeno hidrolizado Evocollagen neutro', 'HSN', 'Suplementos', label(kcal=371, prot=92, carb=0.5, fat=0.3, na=180), '100 g',
   G(('cacito (10 g)', 10), ('2 cacitos (20 g)', 20)), 'etiqueta aproximada, revísala', []),
 ('Collagen Protein Unflavoured', 'MyProtein', 'Suplementos', label(kcal=360, prot=90, carb=0, fat=0, na=150), '100 g',
   G(('cacito (20 g)', 20), ('15 g', 15)), 'etiqueta aproximada, revísala', ['MyProtein, Collagen Protein, Unflavoured', 'My Protein, Collagen Protein, Unflavoured']),
 ('Magnesio quelado (2 cápsulas)', 'HSN', 'Suplementos', label(kcal=0, prot=0, carb=0, fat=0, mg=300), '1 dosis', U('dosis (2 cápsulas)'),
   'etiqueta aproximada, revísala', ['HSN, Chelated Magnesium Veg Caps']),
 ('Omega-3 aceite de pescado (cápsula)', 'HSN', 'Suplementos', label(kcal=9, prot=0, carb=0, fat=1, o3=0.3), '1 cápsula', U('cápsula'),
   'etiqueta aproximada, revísala', ['HSN, Omega-3 Fish Oil']),
 ('Creatina monohidrato', '', 'Suplementos', label(kcal=0, prot=0, carb=0, fat=0), '1 dosis', U('dosis (3-5 g)'), 'sin calorías', []),
 ('Psyllium en polvo', 'Naturitas', 'Suplementos', label(kcal=200, prot=2, carb=4, fat=0.6, fib=85, na=5), '100 g',
   G(('cucharada (8 g)', 8), ('10 g', 10)), 'etiqueta aproximada, revísala', ['naturitas essentials, psyllium en polvo ()']),
 ('Floradix comprimidos (hierro)', 'Salus', 'Suplementos', label(kcal=0, prot=0, carb=0, fat=0), '1 comprimido', U('comprimido'),
   'faltan datos: completa con la etiqueta', ['Salus, Floradix Tablets, Germany']),
 ('Skyr natural', 'Eroski', 'Huevos y lácteos', label(kcal=63, prot=11, carb=4, fat=0.2, ca=150), '100 g',
   G(('envase (150 g)', 150)), 'etiqueta aproximada, revísala', ['Eroski, Skyr, Natural']),
 ('Mini Almond', 'Magnum', 'Dulces y otros', label(kcal=158, prot=2.4, carb=14, fat=10, sat=6, sug=13), '1 helado', U('helado mini'),
   'etiqueta aproximada, revísala', ['Magnum, Mini Bar, Almond']),
 ('Queso fresco Burgos desnatado 0%', 'Hacendado', 'Huevos y lácteos', label(kcal=50, prot=9, carb=3.5, fat=0.2, ca=180, na=400), '100 g',
   G(('ración (60 g)', 60), ('tarrina (250 g)', 250)), 'etiqueta aproximada, revísala', ['Hacendado, Queso Fresco Burgos Desnatado 0%']),
 ('Yogur +Proteínas natural', 'Hacendado', 'Huevos y lácteos', label(kcal=55, prot=10, carb=3.5, fat=0.2, ca=120), '100 g',
   G(('unidad (120 g)', 120)), 'etiqueta aproximada, revísala', ['Hacendado, +Proteinas, Yogur, Natural', 'Hacendado, +Protein, Yogurt, Natural']),
 ('Chocolate negro 85%', 'Eroski', 'Dulces y otros', None, '100 g', G(('onza (8 g)', 8)), 'USDA', ['eroski, chocolate negro 85% cacao ()']),
]
SRREF = {'Chocolate negro 85%': r'^Chocolate, dark, 70-85% cacao solids$'}
for name, brand, grp, nut, base, pt, src, cr in MINE:
    if nut is None:
        r = sr28.find(rows, SRREF[name])[0]; nut = {k: r4(v) for k, v in r['nut'].items()}
    foods.append({'id': 'm-' + slug((brand + ' ' if brand else '') + name), 'n': name, 'brand': brand, 'g': grp, 'src': src,
                  'base': base, 'nut': nut, 'pt': pt, 'mine': True, 'uses': sum(uses[c] for c in cr)})
# 3) Recetas guardadas (con totales exactos de Cronometer)
RECIPES = [('Tostada cottage pavo', from_solved('tostada cottage pavo', 'full recipe', 1), 'tostada cottage pavo')]
for name, nut, cr in RECIPES:
    foods.append({'id': 'r-' + slug(name), 'n': name, 'g': 'Recetas', 'src': 'tu receta de Cronometer (sin micronutrientes)', 'base': '1 receta',
                  'nut': nut, 'pt': [{'n': 'receta entera', 'f': 1}, {'n': 'media', 'f': 0.5}], 'mine': True, 'recipe': True, 'uses': uses[cr]})
# Básicos que usas mucho: marcarlos como tuyos
FAV = {'b-pechuga-de-pollo-a-la-plancha': ['Pechuga de pollo, sin piel antes de cocinar', 'pollo, pechuga entera familiar ()', 'Chicken Breast, Skinless, Cooked'],
       'b-arroz-blanco-cocido': ['Arroz basmati, cocido en agua sin sal', 'Basmati-Reis, in ungesalzenem Wasser gekocht', 'Basmati Rice, Cooked in Unsalted Water', 'Basmati Rice, Cooked in Salted Water'],
       'b-platano': ['Platano'], 'b-semillas-de-chia': ['Chia Seeds', 'Semillas de chía', 'Hacendado, Chia Seeds'],
       'b-copos-de-avena': ['Copos de avena, tradicionales o rápidos, secos', 'Briiggen, Rolled Oats', 'Rolled Oats, dry'],
       'b-yogur-griego-natural-0': ['Greek Yogurt, Plain, Nonfat', 'Yogur griego natural desnatado'],
       'b-kiwi-verde': ['Kiwi Fruit, Green', 'Kiwi verde', 'Kiwifruit, Green, Raw'], 'b-kiwi-amarillo-sungold': ['Kiwi SunGold'],
       'b-aguacate': ['Aguacate Hass', 'Avocado, Black Skin', 'Avocado, schwarze Schale'],
       'b-garbanzos-cocidos-bote': ['Garbanzos en conserva, escurridos y enjuagados'], 'b-tomate': ['Tomate crudo, incluidos tomate cherry, tomate uva y tomate roma', 'Tomato, Red, Raw'],
       'b-cebolla': ['Cebolla blanca, amarilla o roja, cruda'], 'b-huevo-cocido': ['Eggs, Cooked'], 'b-patata-asada': ['Patata asada, sin piel'],
       'b-salmon-rojo-sockeye-crudo': ['Salmon, Red, Sockeye, Raw', 'Salmón rojo (sockeye) de Alaska, crudo'], 'b-brocoli-crudo': ['Broccoli, Raw'],
       'b-carne-de-caballo-cruda': ['Horse Meat', 'Carne de caballo'], 'b-espinacas-crudas': ['Spinach, Raw', 'Espinaca cruda'],
       'b-bonito-del-norte-albacora-en-conserva': ['Bonito del norte cocido'], 'b-salmon-ahumado': ['Salmon, Smoked', 'Martiko, Salmón Ahumado Noruego']}
ids = {f['id'] for f in foods}
for fid, names in FAV.items():
    assert fid in ids, fid
    for f in foods:
        if f['id'] == fid: f['mine'] = True; f['uses'] = sum(uses[c] for c in names)
# Porciones por defecto más útiles para algunos básicos
EXTRA = {'b-huevo-cocido': [('unidad (50 g)', 50)], 'b-huevo-entero-crudo': [('unidad (50 g)', 50)], 'b-platano': [('unidad pequeña (100 g)', 100), ('70 g', 70)],
         'b-kiwi-verde': [('unidad (70 g)', 70)], 'b-kiwi-amarillo-sungold': [('unidad (80 g)', 80)], 'b-aguacate': [('medio (70 g)', 70)],
         'b-pechuga-de-pollo-a-la-plancha': [('filete (150 g)', 150)], 'b-copos-de-avena': [('20 g', 20), ('40 g', 40)]}
for f in foods:
    for n, g in EXTRA.get(f['id'], []): f['pt'].insert(1, {'n': n, 'f': r4(g / 100)})
assert len(ids) == len(foods), 'ids repetidos'
meta = [{'k': k, 'l': l, 'u': u, 't': t} for k, l, u, t, *_ in N]
# omega-3 de omega3.json (ABBREV no lo trae)
_o3 = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'omega3.json'), encoding='utf-8'))
for _f in foods:
    if _f['id'] in _o3: _f['nut']['o3'] = _o3[_f['id']]
json.dump({'version': 1, 'nutrients': meta, 'foods': foods}, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(foods), 'alimentos;', sum(1 for f in foods if f.get('mine')), 'tuyos;', os.path.getsize(OUT) // 1024, 'KB')
