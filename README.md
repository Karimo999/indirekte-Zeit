# Indirekte Zeit

Desktop-App für Mac und Windows. Sie trägt in Kilanka-Leistungsnachweise (PDF) die **indirekten Stunden**
und die **Gesamtstunden** ein. Fehlen die beiden Zeilen in der PDF (heutiger Kilanka-Stand mit nur
„Summe“), fügt die App sie unter „Summe“ im Stil der Tabelle ein.

Die Leistungsnachweise werden nur auf dem eigenen Rechner verarbeitet. Es wird nichts hochgeladen.

## Berechnung

| Standort | Indirekte Stunden |
|---|---|
| Segeberg | 12 Minuten pro Anwesenheitstag (Tag mit gebuchten Stunden; mehrere Einträge am selben Tag zählen als ein Tag) |
| Pinneberg | 20 % der direkten Stunden, höchstens 3 Std. pro Woche und höchstens 13,02 Std. im Monat |

Gesamtstunden = direkte Stunden aus dem Nachweis + indirekte Stunden. Alle Werte in Dezimalstunden mit
zwei Nachkommastellen, kaufmännisch gerundet.

## Bedienung

1. Standort wählen.
2. PDF-Dateien, einen Ordner oder die ZIP-Datei aus Kilanka ins Fenster ziehen (oder „Dateien öffnen …“).
3. Werte prüfen, **Speichern …**: Bei einer Datei öffnet sich „Speichern unter“, bei mehreren wählst du den
   Ordner. Die ergänzten Dateien heißen `…_ergaenzt.pdf`; gibt es eine Datei dort schon, fragt die App vor dem
   Ersetzen. Der zuletzt gewählte Ordner wird beim nächsten Mal vorgeschlagen. Das Original wird nie überschrieben.

4. **Mitarbeiter** (Umschalter über der Liste): indirekte Stunden je betreuender Fachkraft und Monat, summiert
   über alle geladenen Nachweise. Diese Werte gehören ins Stundenkonto in Kilanka, als manuelle Buchung:
   **Mitarbeiter → Konten → Stundenkonto → Plus** (Stichtag, Buchungswert, Bemerkung; die App zeigt alle drei
   zum Kopieren). Derselbe Nachweis in mehreren Dateien wird nur einmal gezählt.

5. **Zeitnachweise (Excel):** Den Zeitnachweis eines Mitarbeiters aus Kilanka (Excel-Export) einfach mit
   ablegen. Die App zählt alle Einträge mit Klient und rechnet die indirekten Stunden je Klient nach den
   Regeln des Standorts (Segeberg: 12 Min. pro Tag mit Klient; Pinneberg: 20 % mit Obergrenze). Das Ergebnis
   steht unter **Mitarbeiter**, mit Stichtag, Buchungswert und Bemerkung zum Kopieren. Ist für denselben
   Mitarbeiter und Monat auch ein Leistungsnachweis geladen, zählt nur der Zeitnachweis.

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
