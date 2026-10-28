"""Kopiert die Testfaelle (Typst-0.13-Fassung) nach web/test/faelle und schreibt erwartet.json."""
import json, os, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
ZIEL = os.path.join(HERE, '..', 'web', 'test', 'faelle')
exp = json.load(open(os.path.join(OUT, 'expected.json')))
for f in os.listdir(ZIEL):
    if f.endswith('.pdf') and f != 'kilanka_aktuell_ohne_felder.pdf':
        os.remove(os.path.join(ZIEL, f))
erwartet = {}
for f, e in sorted(exp.items()):
    if '__' in f:
        continue
    shutil.copy(os.path.join(OUT, f), os.path.join(ZIEL, f))
    erwartet[f] = e
erwartet['kilanka_aktuell_ohne_felder.pdf'] = {'variant': 'alt', 'nachweise': [
    {'tage': 7, 'direkt': '30,83', 'indirekt': '1,40', 'gesamt': '32,23', 'pinneberg': {'indirekt': '6,17', 'gesamt': '37,00'}}]}
json.dump(erwartet, open(os.path.join(ZIEL, 'erwartet.json'), 'w'), ensure_ascii=False, indent=1)
print(len(erwartet), 'Testfaelle')
