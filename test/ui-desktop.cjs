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
          if (!args.ordner && args.original.startsWith('C:\\Schreibgeschuetzt')) throw 'keine Schreibberechtigung';
          const basis = args.ordner || args.original.replace(/\\[^\\]+$/, '');
          const ziel = basis + '\\' + args.relativ.split('/').join('\\');
          m.geschrieben.push({ ziel, bytes: args.daten.length, kopf: String.fromCharCode(...args.daten.slice(0, 5)) });
          return ziel;
        }
        if (cmd === 'im_ordner_zeigen') { m.gezeigt = args.pfad; return null; }
        throw new Error('unbekannter Befehl ' + cmd);
      },
    },
    app: { getVersion: async () => '1.1.0' },
    dialog: {
      async open(opts) { m.auswahl.push(opts); return opts.directory ? 'C:\\Users\\Moritz\\Documents' : m.naechsteAuswahl || null; },
      async ask() { return true; },
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
    pruefe(z[0].includes('1,40') && z[0].includes('32,23'), 'Oktober: 1,40 / 32,23');
    pruefe(z.some((x) => x.includes('Unter der Tabelle ist kein Platz')), 'Fehlerfall „kein Platz“ angezeigt');
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
    const idx = z.findIndex((x) => x.includes('kein Platz'));
    await page.click(`.zeile >> nth=${idx}`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `${schema}-5-fehler.png`) });

    // Speichern (eine Datei liegt in einem schreibgeschuetzten Ordner -> Ordnerauswahl)
    const vorher = await page.textContent('#btn-speichern');
    await page.click('#btn-speichern');
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => window.__mock);
    console.log('GESCHRIEBEN:\n' + m.geschrieben.map((g) => `${g.ziel} (${g.bytes} B, ${g.kopf})`).join('\n'));
    pruefe(vorher.includes('7 Dateien'), `Knopf „${vorher}“`);
    pruefe(m.geschrieben.length === 7, '7 Dateien geschrieben');
    pruefe(m.geschrieben.some((g) => g.ziel === 'C:\\Users\\Moritz\\Desktop\\Nachweis_Oktober_ergaenzt.pdf'), 'neben dem Original gespeichert');
    pruefe(m.geschrieben.some((g) => g.ziel === 'C:\\Users\\Moritz\\Downloads\\Massnahmen_ergaenzt\\Nachweis_Teilmonat_ergaenzt.pdf'), 'ZIP-Inhalt in Ordner neben der ZIP');
    pruefe(m.geschrieben.some((g) => g.ziel === 'C:\\Users\\Moritz\\Documents\\Nur_lesen_ergaenzt.pdf'), 'schreibgeschützt -> gewählter Ordner');
    pruefe(m.geschrieben.every((g) => g.kopf === '%PDF-'), 'alles PDF-Daten');
    pruefe(await page.isVisible('#btn-zeigen'), '„Im Ordner zeigen“ sichtbar');
    pruefe(await page.isDisabled('#btn-speichern'), 'Speichern danach deaktiviert');
    await page.click('#btn-zeigen');
    await page.waitForTimeout(200);
    pruefe((await page.evaluate(() => window.__mock.gezeigt)) !== undefined, 'Im Ordner zeigen aufgerufen');
    await page.screenshot({ path: path.join(OUT, `${schema}-6-gespeichert.png`) });

    // Ansicht „Mitarbeiter“: indirekte Stunden je Fachkraft und Monat fuer das Stundenkonto
    await page.click('#ans-mitarbeiter');
    await page.waitForTimeout(300);
    const ma = await zeilen(page);
    console.log('MITARBEITER:\n' + ma.join('\n'));
    pruefe(ma.length === 5, `5 Gruppen Mitarbeiter/Monat (${ma.length})`);
    pruefe(ma[0].startsWith('Begleiterin, Anna | Februar 2026 · 1 Nachweis') && ma[0].includes('3,00'), 'Begleiterin Februar 3,00');
    pruefe(ma[2].startsWith('Fachkraft, Tina | April 2026 · 2 Nachweise') && ma[2].includes('11,20'), 'Tina April 11,20 (inkl. nicht eingetragenem Nachweis)');
    // Nachweis_Oktober, Sammel (3. Nachweis) und Nur_lesen enthalten denselben Nachweis -> nur einmal zaehlen
    const okt = ma.findIndex((z) => z.startsWith('Schulbegleiter, Max | Oktober 2026'));
    pruefe(okt >= 0 && ma[okt].includes('1,40') && ma[okt].includes('1 Nachweis'), 'Max Oktober 1,40, doppelte Nachweise nur einmal');
    pruefe(ma.some((z) => z.startsWith('Schulbegleiter, Max | September 2026 · 1 Nachweis') && z.includes('3,80')), 'Max September 3,80');
    await page.click(`.zeile >> nth=${okt}`);
    await page.waitForTimeout(200);
    const buchung = await page.$$eval('.buchung tr', (trs) => trs.map((t) => [...t.children].slice(0, 2).map((c) => c.textContent).join('=')));
    console.log('BUCHUNG: ' + buchung.join(' | '));
    pruefe(buchung.join('|') === 'Stichtag=31.10.2026|Buchungswert=1,40|Bemerkung=Indirekte Zeit Oktober 2026', 'Werte für die manuelle Buchung');
    pruefe((await page.textContent('#ma-detail')).includes('nur einmal gezählt'), 'doppelte Nachweise werden genannt');
    pruefe(await page.isHidden('#vorschau'), 'Vorschau in der Mitarbeiter-Ansicht ausgeblendet');
    pruefe((await page.textContent('#status')).includes('Mitarbeiter'), 'Status zeigt Mitarbeiter-Summe');
    await page.click('.buchung tr:nth-child(2) .link');
    await page.waitForTimeout(100);
    const kopiert = await page.textContent('.buchung tr:nth-child(2) .link');
    pruefe(kopiert === 'Kopiert' || kopiert === 'Nicht möglich', `Kopieren-Knopf reagiert (${kopiert})`);
    await page.screenshot({ path: path.join(OUT, `${schema}-6b-mitarbeiter.png`) });
    await page.click('#ans-nachweise');
    await page.waitForTimeout(800);
    pruefe((await zeilen(page)).length === 10, 'zurück zur Nachweis-Ansicht');

    // Standort wechseln
    await page.click('#st-pinneberg');
    await page.waitForTimeout(1500);
    const zp = await zeilen(page);
    pruefe(zp[0].includes('6,17') && zp[0].includes('37,00'), 'Pinneberg: 6,17 / 37,00');
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
