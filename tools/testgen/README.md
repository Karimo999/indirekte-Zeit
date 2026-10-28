# Testfälle erzeugen

Nachbauten des Kilanka-Leistungsnachweises mit [Typst](https://typst.app) (Python-Paket `typst`), Logo und
Unterschrift sind Platzhalter, alle Namen erfunden.

```bash
pip install typst pikepdf
python3 gen.py            # out/*.pdf + out/expected.json
python3 make_variants.py  # variants/: zusätzlich Objekt-Streams, linearisiert, kaputte Xref, Vorschau-Revision (braucht qpdf)
python3 run_tests.py segeberg && python3 run_tests.py pinneberg
python3 sync_faelle.py    # kopiert die Fälle nach test/faelle
```

Mit `TYPST_PYTHON_ALT=/pfad/zu/python` (Python mit älterer typst-Version) entsteht jeder Fall zusätzlich in
einer zweiten Typst-Fassung.
