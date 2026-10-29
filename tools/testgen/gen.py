#!/usr/bin/env python3
"""Erzeugt Test-Leistungsnachweise (Typst, wie Kilanka) + erwartete Werte."""
import json, os, sys, subprocess, datetime, random
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


def de(d: Decimal) -> str:
    q = d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{q:.2f}".replace(".", ",")


def hours(von: str, bis: str) -> Decimal:
    h1, m1 = map(int, von.split(":")); h2, m2 = map(int, bis.split(":"))
    mins = (h2 * 60 + m2) - (h1 * 60 + m1)
    return (Decimal(mins) / Decimal(60)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def row(date: datetime.date, von=None, bis=None, inhalt="Schulbegleitung", bem=""):
    tag = f"{date:%d.%m.%Y} {WD[date.weekday()]}"
    if von is None:
        return {"tag": tag, "zeit": "", "std": "", "inhalt": "", "bem": bem, "_h": Decimal(0), "_m": 0}
    h = hours(von, bis)
    h1, m1 = map(int, von.split(":")); h2, m2 = map(int, bis.split(":"))
    mins = (h2 * 60 + m2) - (h1 * 60 + m1)
    return {"tag": tag, "zeit": f"{von} - {bis}", "std": de(h), "inhalt": inhalt, "bem": bem, "_h": h, "_m": mins}


def pinneberg(direkt: Decimal, zeitraum: str):
    import calendar
    a, b = [datetime.datetime.strptime(x.strip(), "%d.%m.%Y").date() for x in zeitraum.split(" - ")]
    voll = a.day == 1 and b.day == calendar.monthrange(b.year, b.month)[1]
    if voll:
        monate = (b.year - a.year) * 12 + (b.month - a.month) + 1
        grenze = Decimal("13.02") * monate
    else:
        tage = (b - a).days + 1
        grenze = (Decimal(3) * Decimal(tage) / Decimal(7)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    anteil = (direkt * Decimal("0.2")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    ind = min(anteil, grenze)
    return {"indirekt": de(ind), "gesamt": de(direkt + ind)}


def nachweis(name, fachkraft, zeitraum, bewilligt, rows, min_per_day=12):
    # Kilanka summiert exakte Minuten (nicht die gerundeten Zeilenwerte)
    direkt = (Decimal(sum(r["_m"] for r in rows)) / Decimal(60)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    days = sorted({r["tag"][:10] for r in rows if r["_h"] > 0})
    indirekt = Decimal(len(days)) * Decimal(min_per_day) / Decimal(60)
    gesamt = direkt + indirekt
    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    return {
        "name": name, "fachkraft": fachkraft, "zeitraum": zeitraum, "bewilligt": bewilligt,
        "rows": clean, "direkt": de(direkt), "indirekt": de(indirekt), "gesamt": de(gesamt),
        "_expect": {"tage": len(days), "direkt": de(direkt), "indirekt": de(indirekt), "gesamt": de(gesamt), "fachkraft": fachkraft,
                    "pinneberg": pinneberg(direkt, zeitraum)},
    }


def september_muster():
    d = lambda day: datetime.date(2026, 9, day)
    rows = [
        row(d(1), "08:10", "12:00", bem="Stundenausfall, letzte Stunde."),
        row(d(2), "10:00", "14:00"),
        row(d(3), "10:00", "15:00"),
        row(d(4), "08:00", "14:00", inhalt="Ausflug"),
    ]
    for day in (10, 11, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25):
        rows.append(row(d(day), "08:00", "13:15"))
    rows.append(row(d(28), "08:00", "20:00"))
    rows.append(row(d(29), "08:00", "20:00", inhalt="Klassenfahrt"))
    rows.append(row(d(30), "08:00", "20:00", inhalt="Klassenfahrt"))
    return nachweis("Begleitkind, Maxime", "Schulbegleiter, Max", "01.09.2026 - 30.09.2026", "257,14", rows)


def oktober_real():
    d = lambda day: datetime.date(2026, 10, day)
    rows = [
        row(d(1), "08:15", "13:15"), row(d(2), "08:15", "12:15"), row(d(5), "08:00", "14:00"),
        row(d(6), "08:15", "13:15"),
        row(d(7), "08:15", "13:10", inhalt="Schulbegleitung - Abweichende Zeit", bem="abweichung"),
        row(d(8), "08:15", "13:10", inhalt="Schulbegleitung - Abweichende Zeit", bem="Kk"),
        row(d(9), "17:00", "18:00"),
    ]
    return nachweis("Begleitkind, Maxime", "Schulbegleiter, Max", "01.10.2026 - 31.10.2026", "265,71", rows)


def lang_mehrseitig(seed=1):
    """Viele Eintraege (2 pro Tag an manchen Tagen) -> Tabelle ueber 2 Seiten."""
    rnd = random.Random(seed)
    rows = []
    day = datetime.date(2026, 11, 1)
    while day.month == 11:
        if day.weekday() < 5:
            rows.append(row(day, "07:45", rnd.choice(["12:30", "13:15", "13:45", "11:50"])))
            if rnd.random() < 0.45:  # Nachmittagstermin am selben Tag
                rows.append(row(day, "14:00", rnd.choice(["15:00", "15:30", "16:10"]), inhalt="Hausaufgabenbetreuung"))
            if rnd.random() < 0.25:
                rows.append(row(day, "16:30", "17:15", inhalt="Elterngespräch"))
        day += datetime.timedelta(days=1)
    return nachweis("Mustermann, Lea", "Fachkraft, Tina", "01.11.2026 - 30.11.2026", "310,00", rows)


def alle_tage():
    """Variante 'alle Tage des Zeitraums' – leere Tage ohne Stunden duerfen nicht zaehlen."""
    rows = []
    day = datetime.date(2026, 2, 1)
    while day.month == 2:
        if day.weekday() < 5 and day.day not in (16, 17, 18, 19, 20):  # Ferienwoche
            rows.append(row(day, "08:00", "12:30"))
        else:
            rows.append(row(day))
        day += datetime.timedelta(days=1)
    return nachweis("Beispiel, Jonas", "Begleiterin, Anna", "01.02.2026 - 28.02.2026", "120,00", rows)


def kurz(name, n, start=3):
    rows = [row(datetime.date(2026, 9, start + i), "08:00", "11:20") for i in range(n)
            if datetime.date(2026, 9, start + i).weekday() < 5]
    return nachweis(name, "Fachkraft, Ole", "01.09.2026 - 30.09.2026", "80,00", rows)


CASES = {
    "01_muster_sept": ("muster", [september_muster()]),
    "02_summe_okt": ("summe", [oktober_real()]),
    "03_mehrseitig_nov": ("muster", [lang_mehrseitig()]),
    "04_sammel_3_nachweise": ("muster", [september_muster(), kurz("Kind, Emil", 9), oktober_real()]),
    "05_alle_tage_feb": ("muster", [alle_tage()]),
    "06_bereits_gefuellt": ("gefuellt", [september_muster()]),
    "07_alt_nur_summe": ("alt", [oktober_real()]),
    "08_umbruch_gesamt_s2": ("muster", None),
    "09_umbruch_indirekt_s2": ("muster", None),
    "10_zwei_seiten": ("muster", None),
}


def compile_case(name, variant, nws, typst_python, tag, optionen=None):
    data = {"variant": variant, "nachweise": [{k: v for k, v in n.items() if k != "_expect"} for n in nws]}
    data.update(optionen or {})
    dpath = os.path.join(HERE, f"data_{name}.json")
    with open(dpath, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    out = os.path.join(OUT, f"{name}{tag}.pdf")
    code = (
        "import typst,sys;"
        f"typst.compile({os.path.join(HERE,'nachweis.typ')!r}, output={out!r}, root={HERE!r},"
        f" font_paths=[{os.path.join(HERE,'fonts')!r}], ignore_system_fonts=True,"
        f" sys_inputs={{'data': {os.path.basename(dpath)!r}}})"
    )
    subprocess.run([typst_python, "-c", code], check=True)
    return out


def pinneberg_fall(minuten_gesamt, name, zeitraum="01.10.2026 - 31.10.2026", start=datetime.date(2026, 10, 1)):
    """Eintraege a 5 Std., Rest im letzten Eintrag -> exakte Monatssumme"""
    rows = []
    day = start
    rest = minuten_gesamt
    while rest > 0:
        if day.weekday() < 5:
            m = min(300, rest)
            if rest - m < 60 and rest - m > 0:
                m = rest  # letzten Rest anhaengen
            h, mm = divmod(8 * 60 + m, 60)
            rows.append(row(day, "08:00", f"{h:02d}:{mm:02d}"))
            rest -= m
        day += datetime.timedelta(days=1)
    return nachweis(name, "Fachkraft, Ole", zeitraum, "80,00", rows)


def viele_eintraege(n_rows, seed=7, name="Langer, Paul"):
    """n_rows Eintraege (mehrere pro Tag) -> mehrseitige Tabelle."""
    rnd = random.Random(seed)
    rows = []
    day = datetime.date(2026, 3, 2)
    while len(rows) < n_rows:
        if day.weekday() < 5:
            rows.append(row(day, "07:30", rnd.choice(["11:45", "12:30", "13:15"])))
            if len(rows) < n_rows and rnd.random() < 0.6:
                rows.append(row(day, "14:00", rnd.choice(["15:00", "15:45"]), inhalt="Hausaufgabenbetreuung"))
        day += datetime.timedelta(days=1)
    return nachweis(name, "Fachkraft, Tina", f"02.03.2026 - {day:%d.%m.%Y}", "500,00", rows)


if __name__ == "__main__":
    CASES["08_umbruch_gesamt_s2"] = ("muster", [viele_eintraege(38)])
    CASES["09_umbruch_indirekt_s2"] = ("muster", [viele_eintraege(39)])
    CASES["10_zwei_seiten"] = ("muster", [viele_eintraege(50)])
    CASES["14_strich_in_feldern"] = ("strich", [oktober_real()])
    CASES["15_andere_beschriftung"] = ("labels2", [september_muster()])
    CASES["16_freitext_unterstriche"] = ("frei", [oktober_real()])
    CASES["11_pinneberg_65_1"] = ("muster", [pinneberg_fall(3906, "Grenze, Genau")])
    CASES["12_pinneberg_70"] = ("muster", [pinneberg_fall(4200, "Grenze, Drueber")])
    CASES["13_teilmonat"] = ("muster", [pinneberg_fall(2400, "Teil, Monat", "15.09.2026 - 30.09.2026", datetime.date(2026, 9, 15))])
    # heutiger Kilanka-Stand (nur "Summe"): die App fuegt die zwei Zeilen selbst ein
    CASES["17_einfuegen_zwei_seiten"] = ("alt", [viele_eintraege(50)])
    CASES["18_einfuegen_sammel"] = ("alt", [september_muster(), kurz("Kind, Emil", 9), oktober_real()])
    CASES["19_einfuegen_volle_breite"] = ("alt", [oktober_real()], {"unterschrift": False})
    CASES["20_einfuegen_seitenende"] = ("alt", [viele_eintraege(38)])
    CASES["21_kein_platz"] = ("alt", [viele_eintraege(39)], {"_label": "kein_platz"})
    CASES["22_pinneberg_einfuegen"] = ("alt", [pinneberg_fall(4200, "Grenze, Drueber")])
    expected = {}
    for name, fall in CASES.items():
        variant, nws = fall[0], fall[1]
        optionen = dict(fall[2]) if len(fall) > 2 else {}
        label = optionen.pop("_label", variant)
        # TYPST_PYTHON_ALT: Python mit aelterer typst-Version (z. B. 0.13) fuer eine zweite Fassung jedes Falls
        pfade = [compile_case(name, variant, nws, os.environ.get("TYPST_PYTHON_ALT", sys.executable), "", optionen)]
        if os.environ.get("TYPST_PYTHON_ALT"):
            pfade.append(compile_case(name, variant, nws, sys.executable, "__typst015", optionen))
        exp = [n["_expect"] for n in nws]
        for p in pfade:
            expected[os.path.basename(p)] = {"variant": label, "nachweise": exp}
        print(name, label, exp)
    with open(os.path.join(OUT, "expected.json"), "w") as f:
        json.dump(expected, f, ensure_ascii=False, indent=1)
