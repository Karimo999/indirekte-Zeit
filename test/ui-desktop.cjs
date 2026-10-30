// Oberflaechentest der Desktop-Fassung in Chromium (wie WebView2 unter Windows).
// Die Tauri-Schnittstellen (Dateien, Dialoge, Updates) werden nachgebildet.
// Aufruf: npm run build && node test/ui-desktop.cjs [ausgabeordner]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { zipSync } = require('fflate');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist/desktop');
const F = path.join(__dirname, 'faelle');
const OUT = process.argv[2] || path.join(ROOT, 'test/bilder');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const p = path.join(DIST, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(DIST) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

// Nachgebildetes Dateisystem (Windows-Pfade)
const b64 = (f) => fs.readFileSync(path.join(F, f)).toString('base64');
const zip = Buffer.from(zipSync({
  'Export/Nachweis_Kind_Emil.pdf': fs.readFileSync(path.join(F, '05_alle_tage_feb.pdf')),
  'Export/Nachweis_Teilmonat.pdf': fs.readFileSync(path.join(F, '13_teilmonat.pdf')),
})).toString('base64');
const DATEIEN = {
  'C:\\Users\\Moritz\\Desktop\\Nachweis_Oktober.pdf': b64('07_alt_nur_summe.pdf'),
  'C:\\Users\\Moritz\\Desktop\\Sammel.pdf': b64('18_einfuegen_sammel.pdf'),
  'C:\\Users\\Moritz\\Desktop\\Langer_Paul.pdf': b64('21_kein_platz.pdf'),
  'C:\\Users\\Moritz\\Downloads\\Kilanka\\A.pdf': b64('01_muster_sept.pdf'),
  'C:\\Users\\Moritz\\Downloads\\Kilanka\\B.pdf': b64('17_einfuegen_zwei_seiten.pdf'),
  'C:\\Users\\Moritz\\Downloads\\Massnahmen.zip': zip,
  'C:\\Schreibgeschuetzt\\Nur_lesen.pdf': b64('19_einfuegen_volle_breite.pdf'),
  'C:\\Users\\Moritz\\Desktop\\Notiz.docx': Buffer.from('kein pdf').toString('base64'),
  'C:\\Users\\Moritz\\Downloads\\Zeitnachweis_Muster_Mia.xlsx': b64('zeitnachweis_muster_mia_2026-09.xlsx'),
  'C:\\Users\\Moritz\\Downloads\\Zeitnachweis_Max.xlsx': b64('zeitnachweis_schulbegleiter_max_2026-09.xlsx'),
  'C:\\Users\\Moritz\\Downloads\\Max_September.pdf': b64('01_muster_sept.pdf'),
  'C:\\Users\\Moritz\\Downloads\\Tabelle.xlsx': Buffer.from('PK kaputt').toString('base64'),
  'C:\\Users\\Moritz\\Downloads\\Zeitnachweis_Volker.xlsx': b64('zeitnachweis_viel_volker_2026-10.xlsx'),
};
const ORDNER = { 'C:\\Users\\Moritz\\Downloads\\Kilanka': ['C:\\Users\\Moritz\\Downloads\\Kilanka\\A.pdf', 'C:\\Users\\Moritz\\Downloads\\Kilanka\\B.pdf'] };

function mock({ dateien, ordner }) {
  const m = { aufrufe: [], geschrieben: [], auswahl: [], drag: null, update: null, neustart: 0 };
  window.__mock = m;
  const ab = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args) {
        m.aufrufe.push(cmd);
        if (cmd === 'dateien_sammeln') return args.pfade.flatMap((p) => ordner[p] || [p]);
        if (cmd === 'datei_lesen') { if (!dateien[args.pfad]) throw 'nicht gefunden'; return ab(dateien[args.pfad]); }
        if (cmd === 'schreiben') {
          if (!args.ordner) throw 'ohne gewählten Ordner wird nicht gespeichert';
          if (args.ordner.startsWith('C:\\Gesperrt')) throw 'keine Schreibberechtigung';
          const ziel = args.ordner + '\\' + args.relativ.split('/').join('\\');
          m.geschrieben.push({ ziel, bytes: args.daten.length, kopf: String.fromCharCode(...args.daten.slice(0, 5)) });
          return ziel;
        }
        if (cmd === 'schreiben_als') {
          if (args.ziel.startsWith('C:\\Gesperrt')) throw 'keine Schreibberechtigung';
          m.geschrieben.push({ ziel: args.ziel, bytes: args.daten.length, kopf: String.fromCharCode(...args.daten.slice(0, 5)), als: true });
          return args.ziel;
        }
        if (cmd === 'vorhandene_dateien') return args.namen.filter((n) => (m.vorhanden || []).includes(n));
        if (cmd === 'im_ordner_zeigen') { m.gezeigt = args.pfad; return null; }
        throw new Error('unbekannter Befehl ' + cmd);
      },
    },
    app: { getVersion: async () => '1.1.0' },
    dialog: {
      async open(opts) { m.auswahl.push(opts); return opts.directory ? m.ordnerWahl : m.naechsteAuswahl || null; },
      async save(opts) { m.auswahl.push(opts); return m.speichernWahl; },
      async ask(text) { m.fragen = (m.fragen || []).concat(text); return m.askAntwort !== undefined ? m.askAntwort : true; },
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: (cb) => { m.drag = cb; return Promise.resolve(() => {}); } }) },
    updater: { async check() { return m.update; } },
    process: { async relaunch() { m.neustart++; } },
  };
}

const ablegen = (page, pfade) => page.evaluate((p) => {
  window.__mock.drag({ payload: { type: 'enter', paths: p, position: { x: 10, y: 10 } } });
  window.__mock.drag({ payload: { type: 'drop', paths: p, position: { x: 10, y: 10 } } });
}, pfade);
const zeilen = (page) => page.$$eval('.zeile', (zs) => zs.map((z) => z.innerText.replace(/\s*\n+\s*/g, ' | ')));

(async () => {
  await new Promise((r) => server.listen(8766, r));
  const browser = await chromium.launch();
  let fehler = 0;
  const pruefe = (bed, text) => { if (!bed) { fehler++; console.log('FEHLER: ' + text); } else console.log('ok: ' + text); };
  for (const schema of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: schema });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(msg.type() + ': ' + msg.text()); });
    page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
    await page.addInitScript(mock, { dateien: DATEIEN, ordner: ORDNER });
    // Update steht bereit (nur im hellen Durchlauf pruefen)
    if (schema === 'light') {
      await page.addInitScript(() => {
        window.__mock.update = {
          version: '1.2.0',
          async downloadAndInstall(cb) {
            cb({ event: 'Started', data: { contentLength: 1000 } });
            cb({ event: 'Progress', data: { chunkLength: 500 } });
            cb({ event: 'Progress', data: { chunkLength: 500 } });
            cb({ event: 'Finished' });
          },
        };
      });
    }
    await page.goto('http://localhost:8766/');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${schema}-1-leer.png`) });
    // Startbildschirm: ein Knopf in der Mitte, keine Reiter, kein Speichern
    pruefe(await page.isVisible('#btn-oeffnen-leer') && await page.isHidden('#btn-oeffnen') && await page.isHidden('#reiter') && await page.isHidden('#btn-speichern'), 'Startbildschirm aufgeräumt');
    await page.evaluate(() => { window.__mock.naechsteAuswahl = null; });
    await page.click('#btn-oeffnen-leer');
    await page.waitForTimeout(200);
    pruefe((await page.evaluate(() => window.__mock.auswahl.length)) === 1, '„Dateien öffnen …“ in der Mitte öffnet den Dialog');
    if (schema === 'light') {
      await page.waitForTimeout(2000);
      pruefe(await page.isVisible('#update'), 'Update-Hinweis sichtbar');
      pruefe((await page.textContent('#update-text')).includes('1.2.0'), 'Update-Version angezeigt');
      await page.screenshot({ path: path.join(OUT, `${schema}-2-update.png`) });
    }

    // Dateien, Ordner, ZIP und eine falsche Datei ablegen
    await ablegen(page, [
      'C:\\Users\\Moritz\\Desktop\\Nachweis_Oktober.pdf',
      'C:\\Users\\Moritz\\Desktop\\Sammel.pdf',
      'C:\\Users\\Moritz\\Desktop\\Langer_Paul.pdf',
      'C:\\Users\\Moritz\\Downloads\\Kilanka',
      'C:\\Users\\Moritz\\Downloads\\Massnahmen.zip',
      'C:\\Schreibgeschuetzt\\Nur_lesen.pdf',
      'C:\\Users\\Moritz\\Desktop\\Notiz.docx',
    ]);
    await page.waitForTimeout(1500);
    const z = await zeilen(page);
    console.log(z.join('\n'));
    pruefe(z.length === 10, `10 Nachweise in der Liste (${z.length})`);
    pruefe(await page.isVisible('#reiter') && await page.isVisible('#btn-oeffnen') && (await page.textContent('#anz-nachweise')) === '10', 'Reiter und „Dateien öffnen …“ oben sichtbar');
    pruefe(z[0].includes('1,40') && z[0].includes('32,23'), 'Oktober: 1,40 / 32,23');
    pruefe(z.some((x) => x.startsWith('Langer, Paul') && x.includes('Nicht eingetragen')), 'Fehlerfall in der Liste kurz markiert');
    pruefe((await page.textContent('#status')).includes('Notiz.docx'), 'falsche Datei gemeldet');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `${schema}-3-liste.png`) });

    // zweiten Nachweis der Sammel-PDF waehlen
    await page.click('.zeile >> nth=2');
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, `${schema}-4-auswahl.png`) });
    pruefe((await page.textContent('#detail-kopf')).includes('Kind, Emil'), 'Detail zeigt gewählten Nachweis');
    const leinwand = await page.$eval('.vorschau canvas', (c) => c.width > 100);
    pruefe(leinwand, 'Vorschau gezeichnet');

    // Fehlerzeile anklicken
    const idx = z.findIndex((x) => x.includes('Nicht eingetragen'));
    await page.click(`.zeile >> nth=${idx}`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `${schema}-5-fehler.png`) });
    const fk = await page.textContent('#detail-kopf');
    pruefe(fk.includes('Unter der Tabelle ist kein Platz') && fk.includes('Indirekt 4,80 Std. · Gesamt 140,55 Std.'), 'Detail nennt Grund und Werte zum Eintragen von Hand');

    // Speichern: mehrere Dateien -> Ordner waehlen
    const vorher = await page.textContent('#btn-speichern');
    pruefe(vorher === '7 Dateien speichern …', `Knopf „${vorher}“`);
    // a) Ordnerauswahl abgebrochen
    await page.evaluate(() => { window.__mock.ordnerWahl = null; });
    await page.click('#btn-speichern');
    await page.waitForTimeout(400);
    let m = await page.evaluate(() => window.__mock);
    const ordnerDialog = m.auswahl[m.auswahl.length - 1];
    pruefe(ordnerDialog.directory === true && ordnerDialog.defaultPath === 'C:\\Users\\Moritz\\Desktop', `Ordnerdialog startet beim Original (${ordnerDialog.defaultPath})`);
    pruefe(m.geschrieben.length === 0 && !(await page.isDisabled('#btn-speichern')), 'Abbrechen speichert nichts');
    // b) Datei gibt es schon, Ersetzen abgelehnt
    await page.evaluate(() => { Object.assign(window.__mock, { ordnerWahl: 'C:\\Users\\Moritz\\Documents\\Ergaenzt', vorhanden: ['A_ergaenzt.pdf'], askAntwort: false }); });
    await page.click('#btn-speichern');
    await page.waitForTimeout(400);
    m = await page.evaluate(() => window.__mock);
    pruefe(m.fragen && m.fragen[m.fragen.length - 1].includes('A_ergaenzt.pdf') && m.geschrieben.length === 0, 'vorhandene Datei: Rückfrage, nichts ersetzt');
    // c) Ersetzen bestaetigt
    await page.evaluate(() => { window.__mock.askAntwort = true; });
    await page.click('#btn-speichern');
    await page.waitForTimeout(1200);
    m = await page.evaluate(() => window.__mock);
    console.log('GESCHRIEBEN:\n' + m.geschrieben.map((g) => `${g.ziel} (${g.bytes} B, ${g.kopf})`).join('\n'));
    pruefe(m.geschrieben.length === 7, '7 Dateien geschrieben');
    pruefe(m.geschrieben.every((g) => g.ziel.startsWith('C:\\Users\\Moritz\\Documents\\Ergaenzt\\') && g.ziel.endsWith('_ergaenzt.pdf')), 'alle im gewählten Ordner');
    pruefe(new Set(m.geschrieben.map((g) => g.ziel)).size === 7, 'keine Datei überschreibt eine andere');
    pruefe(m.geschrieben.every((g) => g.kopf === '%PDF-'), 'alles PDF-Daten');
    pruefe((await page.textContent('#status')) === '7 Dateien gespeichert in Ergaenzt', 'Status nennt den Ordner');
    pruefe(await page.isVisible('#btn-zeigen'), '„Im Ordner zeigen“ sichtbar');
    pruefe(await page.isDisabled('#btn-speichern'), 'Speichern danach deaktiviert');
    await page.click('#btn-zeigen');
    await page.waitForTimeout(200);
    pruefe((await page.evaluate(() => window.__mock.gezeigt)) !== undefined, 'Im Ordner zeigen aufgerufen');
    await page.screenshot({ path: path.join(OUT, `${schema}-6-gespeichert.png`) });

    // Ansicht „Mitarbeiter“: indirekte Stunden je Fachkraft und Monat fuer das Stundenkonto
    await page.click('#tab-stundenkonto');
    await page.waitForTimeout(300);
    const ma = await zeilen(page);
    console.log('MITARBEITER:\n' + ma.join('\n'));
    pruefe(ma.length === 5, `5 Gruppen Mitarbeiter/Monat (${ma.length})`);
    pruefe(ma[0] === 'Begleiterin, Anna | Februar 2026 · aus dem Leistungsnachweis | 3,00', 'Begleiterin Februar 3,00 (nur der indirekte Wert)');
    pruefe(ma[2] === 'Fachkraft, Tina | April 2026 · aus 2 Leistungsnachweisen | 11,20', 'Tina April 11,20 (inkl. nicht eingetragenem Nachweis)');
    // Nachweis_Oktober, Sammel (3. Nachweis) und Nur_lesen enthalten denselben Nachweis -> nur einmal zaehlen
    const okt = ma.findIndex((z) => z.startsWith('Schulbegleiter, Max | Oktober 2026'));
    pruefe(okt >= 0 && ma[okt] === 'Schulbegleiter, Max | Oktober 2026 · aus dem Leistungsnachweis | 1,40', 'Max Oktober 1,40, doppelte Nachweise nur einmal');
    pruefe(ma.includes('Schulbegleiter, Max | September 2026 · aus dem Leistungsnachweis | 3,80'), 'Max September 3,80');
    await page.click(`.zeile >> nth=${okt}`);
    await page.waitForTimeout(200);
    const buchung = await page.$$eval('.buchung tr', (trs) => trs.map((t) => [...t.children].slice(0, 2).map((c) => c.textContent).join('=')));
    console.log('BUCHUNG: ' + buchung.join(' | '));
    pruefe(buchung.join('|') === 'Stichtag=31.10.2026|Buchungswert=1,40|Bemerkung=Indirekte Zeit Oktober 2026', 'Werte für die manuelle Buchung');
    pruefe((await page.textContent('#ma-detail')).includes('zählt nur einmal'), 'doppelte Nachweise werden genannt');
    pruefe(await page.isHidden('#btn-speichern'), 'kein Speichern-Knopf im Reiter Stundenkonto');
    pruefe(await page.isHidden('#vorschau'), 'Vorschau in der Mitarbeiter-Ansicht ausgeblendet');
    pruefe((await page.textContent('#status')).includes('Mitarbeiter'), 'Status zeigt Mitarbeiter-Summe');
    await page.click('.buchung tr:nth-child(2) .link');
    await page.waitForTimeout(100);
    const kopiert = await page.textContent('.buchung tr:nth-child(2) .link');
    pruefe(kopiert === 'Kopiert' || kopiert === 'Nicht möglich', `Kopieren-Knopf reagiert (${kopiert})`);
    await page.screenshot({ path: path.join(OUT, `${schema}-6b-mitarbeiter.png`) });
    await page.click('#tab-nachweise');
    await page.waitForTimeout(800);
    pruefe((await zeilen(page)).length === 10, 'zurück zur Nachweis-Ansicht');

    // Standort wechseln
    await page.click('#st-pinneberg');
    await page.waitForTimeout(1500);
    const zp = await zeilen(page);
    pruefe(zp[0].includes('6,17') && zp[0].includes('37,00'), 'Pinneberg: 6,17 / 37,00');
    // Pinneberg-Grenze auch je Mitarbeiter: Tina hat zwei Nachweise (14,14 + 19,29) im Zeitraum 02.03.–15.04.
    await page.click('#tab-stundenkonto');
    await page.waitForTimeout(300);
    const zpm = await zeilen(page);
    const tina = zpm.findIndex((z) => z.startsWith('Fachkraft, Tina'));
    pruefe(tina >= 0 && zpm[tina].includes('19,29'), `Pinneberg: Grenze je Mitarbeiter (${zpm[tina]})`);
    await page.click(`.zeile >> nth=${tina}`);
    pruefe((await page.textContent('#ma-detail')).includes('zusammen 33,43 Std., höchstens 19,29 Std.'), 'Hinweis auf die Grenze je Mitarbeiter');
    await page.click('#tab-nachweise');
    await page.waitForTimeout(600);
    pruefe(!(await page.isDisabled('#btn-speichern')), 'nach Standortwechsel wieder speicherbar');
    await page.screenshot({ path: path.join(OUT, `${schema}-7-pinneberg.png`) });

    // Dateidialog
    await page.evaluate(() => { window.__mock.naechsteAuswahl = ['C:\\Users\\Moritz\\Desktop\\Nachweis_Oktober.pdf']; });
    await page.keyboard.press('Control+o');
    await page.waitForTimeout(800);
    pruefe((await zeilen(page)).length === 10, 'gleiche Datei erneut geöffnet ersetzt den Eintrag');

    if (schema === 'light') {
      await page.click('#btn-update');
      await page.waitForTimeout(600);
      const neu = await page.evaluate(() => window.__mock.neustart);
      pruefe(neu === 1, 'Update installiert und Neustart ausgelöst');
    }

    // eine Datei -> „Speichern unter“, startet im zuletzt gewaehlten Ordner
    await page.click('#btn-leeren');
    await ablegen(page, ['C:\\Users\\Moritz\\Desktop\\Nachweis_Oktober.pdf']);
    await page.waitForTimeout(800);
    pruefe((await page.textContent('#btn-speichern')) === 'Speichern …', 'Knopf „Speichern …“ bei einer Datei');
    await page.evaluate(() => { window.__mock.speichernWahl = 'C:\\Users\\Moritz\\Documents\\Ergaenzt\\Oktober_final.pdf'; window.__mock.geschrieben = []; });
    await page.click('#btn-speichern');
    await page.waitForTimeout(500);
    m = await page.evaluate(() => window.__mock);
    const sd = m.auswahl[m.auswahl.length - 1];
    pruefe(sd.defaultPath === 'C:\\Users\\Moritz\\Documents\\Ergaenzt\\Nachweis_Oktober_ergaenzt.pdf', `Speichern-unter startet im letzten Ordner (${sd.defaultPath})`);
    pruefe(m.geschrieben.length === 1 && m.geschrieben[0].als && m.geschrieben[0].ziel.endsWith('Oktober_final.pdf'), 'unter gewähltem Namen gespeichert');
    pruefe((await page.textContent('#status')) === 'Gespeichert als Oktober_final.pdf', 'Status „Gespeichert als …“');
    // Schreibfehler wird gemeldet (Standortwechsel macht die Datei wieder speicherbar)
    await page.click('#st-segeberg');
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__mock.speichernWahl = 'C:\\Gesperrt\\x.pdf'; });
    await page.click('#btn-speichern');
    await page.waitForTimeout(500);
    const st = await page.textContent('#status');
    pruefe(st.includes('Nicht gespeichert') && st.includes('keine Schreibberechtigung') && !(await page.isDisabled('#btn-speichern')), 'Schreibfehler gemeldet, erneut speicherbar');

    // Zeitnachweis (Excel) eines Mitarbeiters: nur der Wert fuers Stundenkonto
    await page.click('#btn-leeren');
    await ablegen(page, ['C:\\Users\\Moritz\\Downloads\\Zeitnachweis_Muster_Mia.xlsx']);
    await page.waitForTimeout(800);
    pruefe((await page.getAttribute('#tab-stundenkonto', 'aria-selected')) === 'true', 'nur Excel abgelegt -> Reiter Stundenkonto');
    pruefe((await page.textContent('#anz-nachweise')) === '0' && (await page.textContent('#anz-stundenkonto')) === '1', 'Anzahl in den Reitern');
    let zx = await zeilen(page);
    console.log('EXCEL:\n' + zx.join('\n'));
    pruefe(zx.length === 1 && zx[0] === 'Muster, Mia | September 2026 · aus dem Zeitnachweis | 1,80', 'Zeitnachweis Segeberg 1,80 (12 Min. pro Eintrag mit Klient)');
    let bx = await page.$$eval('.buchung tr', (trs) => trs.map((t) => [...t.children].slice(0, 2).map((c) => c.textContent).join('=')));
    pruefe(bx.join('|') === 'Stichtag=30.09.2026|Buchungswert=1,80|Bemerkung=Indirekte Zeit September 2026', 'Buchungswerte aus dem Zeitnachweis');
    const mdx = await page.textContent('#ma-detail');
    const rx = await page.$$eval('.rechnung tr', (trs) => trs.map((t) => t.innerText.replace(/\s*\n+\s*/g, ' | ').replace(/\t/g, ' | ')));
    console.log('RECHNUNG: ' + rx.join(' || '));
    pruefe(rx.length === 2 && rx[0] === 'Kind, Anton | 6 Einträge × 12 Min. | 1,20 Std.' && rx[1] === 'Kind, Berta | 3 Einträge × 12 Min. | 0,60 Std.' && mdx.includes('3 Einträge ohne Klient'), 'Aufschlüsselung je Klient');
    await page.screenshot({ path: path.join(OUT, `${schema}-9-zeitnachweis.png`) });
    await page.click('#st-pinneberg');
    await page.waitForTimeout(300);
    zx = await zeilen(page);
    pruefe(zx[0].includes('7,43'), 'Zeitnachweis Pinneberg 7,43');
    await page.click('#btn-leeren');
    await ablegen(page, ['C:\\Users\\Moritz\\Downloads\\Zeitnachweis_Volker.xlsx']);
    await page.waitForTimeout(600);
    zx = await zeilen(page);
    pruefe(zx[0].startsWith('Viel, Volker') && zx[0].includes('13,02') && (await page.textContent('#ma-detail')).includes('zusammen 26,04 Std.'), 'Zeitnachweis Pinneberg: Grenze für den Mitarbeiter (26,04 → 13,02)');
    await page.click('#btn-leeren');
    await ablegen(page, ['C:\\Users\\Moritz\\Downloads\\Zeitnachweis_Muster_Mia.xlsx']);
    await page.waitForTimeout(600);
    await page.click('#st-segeberg');
    await page.click('#tab-nachweise');
    pruefe((await page.textContent('#liste')).includes('Keine Leistungsnachweise geladen'), 'Nachweis-Ansicht weist auf die Zeitnachweise hin');
    // Zeitnachweis und Leistungsnachweis desselben Mitarbeiters im selben Monat -> nur der Zeitnachweis zaehlt
    await ablegen(page, ['C:\\Users\\Moritz\\Downloads\\Max_September.pdf', 'C:\\Users\\Moritz\\Downloads\\Zeitnachweis_Max.xlsx', 'C:\\Users\\Moritz\\Downloads\\Tabelle.xlsx']);
    await page.waitForTimeout(800);
    pruefe((await page.textContent('#status')).includes('Tabelle.xlsx'), 'kaputte Excel-Datei gemeldet');
    await page.click('#tab-stundenkonto');
    await page.waitForTimeout(300);
    zx = await zeilen(page);
    console.log(zx.join('\n'));
    const maxZeile = zx.findIndex((z) => z.startsWith('Schulbegleiter, Max | September 2026'));
    pruefe(zx.filter((z) => z.startsWith('Schulbegleiter, Max | September 2026')).length === 1 && zx[maxZeile].includes('Zeitnachweis') && zx[maxZeile].includes('0,60'), 'Zeitnachweis ersetzt die Werte aus dem Leistungsnachweis');
    await page.click(`.zeile >> nth=${maxZeile}`);
    pruefe((await page.textContent('#ma-detail')).includes('Gezählt wird nur der Zeitnachweis'), 'Hinweis auf den ersetzten Leistungsnachweis');

    // schmales Fenster
    await page.setViewportSize({ width: 820, height: 560 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${schema}-8-klein.png`) });
    const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    pruefe(ueberlauf <= 0, 'kein waagerechter Überlauf bei 820 px');

    if (logs.length) { console.log('KONSOLE:\n' + logs.join('\n')); }
    pruefe(!logs.some((l) => l.startsWith('PAGEERROR')), 'keine Skriptfehler');
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
  process.exit(fehler ? 1 : 0);
})();
