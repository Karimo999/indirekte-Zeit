# Indirekte Zeit

Desktop-App für Mac und Windows. Sie trägt in Kilanka-Leistungsnachweise (PDF) die **indirekten Stunden**
und die **Gesamtstunden** ein. Fehlen die beiden Zeilen in der PDF (heutiger Kilanka-Stand mit nur
„Summe“), fügt die App sie unter „Summe“ im Stil der Tabelle ein.

Die Leistungsnachweise werden nur auf dem eigenen Rechner verarbeitet. Es wird nichts hochgeladen.

## Berechnung

| Standort | Indirekte Stunden |
|---|---|
| Segeberg | 12 Minuten pro Anwesenheitstag (Tag mit gebuchten Stunden; mehrere Einträge am selben Tag zählen als ein Tag) |
| Pinneberg | 20 % der direkten Stunden, höchstens 3 Std. pro Woche und höchstens 13,02 Std. im Monat – die Grenze gilt je Klient und zusätzlich für den Mitarbeiter insgesamt |

Gesamtstunden = direkte Stunden aus dem Nachweis + indirekte Stunden. Alle Werte in Dezimalstunden mit
zwei Nachkommastellen, kaufmännisch gerundet.

## Bedienung

1. Oben den **Standort** wählen.
2. Dateien ins Fenster ziehen oder **Dateien öffnen …**: Leistungsnachweise (PDF), Zeitnachweise der
   Mitarbeiter (Excel), ganze Ordner oder die ZIP-Datei aus Kilanka.
3. Reiter **Leistungsnachweise**: Werte prüfen (rechts die Vorschau), dann **Speichern …**. Bei einer Datei
   öffnet sich „Speichern unter“, bei mehreren wählst du den Ordner. Die ergänzten Dateien heißen
   `…_ergaenzt.pdf`; gibt es eine Datei dort schon, fragt die App vor dem Ersetzen. Das Original wird nie
   überschrieben.
4. Reiter **Stundenkonto**: die indirekte Zeit je Mitarbeiter und Monat, mit Stichtag, Buchungswert und
   Bemerkung zum Kopieren. In Kilanka als manuelle Buchung eintragen: **Mitarbeiter → Konten →
   Stundenkonto → Plus**.
   - Aus Zeitnachweisen (Excel) zählen alle Einträge mit Klient (ein Eintrag mit Klient ist ein
     Klienteneinsatz). Segeberg: 12 Min. pro Eintrag mit Klient. Pinneberg: 20 % je Klient,
     Obergrenze je Klient und für den Mitarbeiter insgesamt.
   - Aus Leistungsnachweisen zählt die betreuende Fachkraft im Nachweis. Ist für denselben Mitarbeiter und
     Monat auch ein Zeitnachweis geladen, zählt nur der Zeitnachweis. Derselbe Nachweis in mehreren Dateien
     zählt einmal.

Kilanka lässt von außen keine Buchungen zu (API und Applets können nur lesen), deshalb ist dieser Schritt
manuell: eine Buchung pro Mitarbeiter und Monat.

Die Originaldatei bleibt unverändert. Die ergänzte Datei enthält das Original Byte für Byte plus eine
angehängte Ergänzung. Vor dem Speichern liest die App das Ergebnis noch einmal und prüft die Werte.

## Installieren

Die Installer liegen unter **Releases** (rechts auf der GitHub-Seite):

- **Windows:** `Indirekte.Zeit_<Version>_x64-setup.exe` herunterladen und starten. Beim ersten Mal
  meldet Windows evtl. „Der Computer wurde durch Windows geschützt“: **Weitere Informationen → Trotzdem ausführen**.
- **Mac:** `Indirekte.Zeit_<Version>_universal.dmg` öffnen und die App in **Programme** ziehen. Beim ersten
  Start meldet macOS, dass die App nicht geprüft werden kann: **Systemeinstellungen → Datenschutz &
  Sicherheit → Dennoch öffnen**. Meldet macOS stattdessen „beschädigt“, einmal im Terminal ausführen:
  `xattr -cr "/Applications/Indirekte Zeit.app"`

Die Warnungen kommen nur beim ersten Installieren, weil die App nicht mit einem kostenpflichtigen
Entwicklerzertifikat signiert ist. Updates laufen danach ohne Rückfrage.

## Updates

Jede installierte App prüft beim Start und danach alle drei Stunden, ob es ein neues Release gibt. Dann
erscheint oben „Version … ist verfügbar“ und **Jetzt aktualisieren** installiert es und startet neu.

**Neue Version veröffentlichen:**

1. `version` in `package.json` erhöhen (z. B. `1.1.0` → `1.2.0`) und committen.
2. Tag pushen: `git tag v1.2.0 && git push origin v1.2.0`
   (oder auf GitHub: **Actions → Release → Run workflow**).
3. GitHub baut die Installer für Mac und Windows (ca. 15 Minuten) und veröffentlicht das Release.
   Ab dann bieten alle installierten Apps das Update an.

Für das Signieren der Updates braucht das Repository zwei Secrets (**Settings → Secrets and variables →
Actions**): `TAURI_SIGNING_PRIVATE_KEY` (Inhalt der Schlüsseldatei) und
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Der Schlüssel gehört nicht ins Repository. Geht er verloren,
können installierte Apps keine Updates mehr annehmen und müssen einmal neu installiert werden.

## Entwicklung

```bash
npm install
npm test          # Rechnung und PDF-Eintragung an allen Testfällen (beide Standorte)
npm run build     # Oberfläche -> dist/desktop (App) und dist/artefakt.html (Testversion im Browser)
npm run tauri dev # App lokal starten (braucht Rust)
```

| Pfad | Inhalt |
|---|---|
| `src/engine/` | PDF lesen, Nachweise erkennen, **Regeln (`STANDORTE` in `nachweis.js`)**, Eintragen per inkrementellem Update, Selbstprüfung |
| `src/app/` | Oberfläche (`ui.js`), Anbindung an die Desktop-App (`desktop.js`) und Testversion (`artefakt.js`) |
| `src-tauri/` | Desktop-Rahmen (Tauri): Dateien lesen und schreiben, Updates |
| `test/` | Testfälle (Nachbauten des Kilanka-Layouts) und erwartete Werte |
| `tools/testgen/` | Erzeugt die Testfälle mit Typst |
| `.github/workflows/` | Tests und Release-Build |

Neuer Standort: in `STANDORTE` einen Eintrag mit `id`, `name`, `kurz` und `berechne(n, direktCenti)`
ergänzen, in `src/app/body.html` einen Knopf `st-<id>` hinzufügen, Testfall ergänzen, `npm test`.
