import re
from nutrients import N
def load(path_abbrev, path_des):
    des = {}
    for l in open(path_des, encoding='latin-1'):
        f = l.rstrip('\r\n').split('^'); des[f[0].strip('~')] = f[2].strip('~')
    rows = {}
    for l in open(path_abbrev, encoding='latin-1'):
        f = [x.strip('~') for x in l.rstrip('\r\n').split('^')]
        nut = {}
        for k, _, _, _, _, i, _ in N:
            if i is not None and f[i] != '':
                nut[k] = float(f[i])
        portions = []
        for w, d in ((f[48], f[49]), (f[50], f[51])):
            if w and d: portions.append({'n': d, 'g': float(w)})
        rows[f[0]] = {'ndb': f[0], 'desc': des.get(f[0], f[1]), 'nut': nut, 'portions': portions}
    return rows
def find(rows, rx):
    return [r for r in rows.values() if re.search(rx, r['desc'], re.I)]
