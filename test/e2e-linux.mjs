// Ende-zu-Ende-Test der echten Desktop-App unter Linux (WebKitGTK) per WebDriver (tauri-driver).
// Voraussetzung: Xvfb auf DISPLAY, tauri-driver und WebKitWebDriver installiert, App gebaut (cargo build).
// Aufruf: node test/e2e-linux.mjs <pfad-zur-app> <ausgabeordner>
import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { verarbeite } from '../src/engine/nachweis.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.argv[2] || join(ROOT, 'src-tauri/target/debug/indirekte-zeit');
const OUT = process.argv[3] || join(ROOT, 'test/bilder-e2e');
const F = join(ROOT, 'test/faelle');
mkdirSync(OUT, { recursive: true });

// Testordner mit Leistungsnachweisen (Name mit Umlaut und Leerzeichen)
const ORDNER = '/tmp/indirekte-zeit-e2e/Nachweise Oktober Ü';
rmSync('/tmp/indirekte-zeit-e2e', { recursive: true, force: true });
mkdirSync(join(ORDNER, 'Unterordner'), { recursive: true });
copyFileSync(join(F, '07_alt_nur_summe.pdf'), join(ORDNER, 'Begleitkind_Oktober.pdf'));
copyFileSync(join(F, '18_einfuegen_sammel.pdf'), join(ORDNER, 'Sammel.pdf'));
copyFileSync(join(F, '21_kein_platz.pdf'), join(ORDNER, 'Unterordner', 'Langer.pdf'));
writeFileSync(join(ORDNER, 'Export.zip'), zipSync({
  'Export/Teilmonat.pdf': readFileSync(join(F, '13_teilmonat.pdf')),
  'Export/Muster.pdf': readFileSync(join(F, '01_muster_sept.pdf')),
}));
writeFileSync(join(ORDNER, 'Notiz.txt'), 'kein pdf');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WD = 'http://127.0.0.1:4444';
async function wd(method, pfad, body) {
  const r = await fetch(WD + pfad, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${pfad}: ${j.value.error} ${j.value.message}`);
  return j.value;
}

let fehler = 0;
const pruefe = (bed, text) => { if (!bed) { fehler++; console.log('FEHLER: ' + text); } else console.log('ok: ' + text); };

const treiber = spawn('tauri-driver', [], { stdio: ['ignore', 'pipe', 'pipe'] });
treiber.stderr.on('data', () => {});
await sleep(1500);
let session;
try {
  const s = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
  session = s.sessionId;
  const S = `/session/${session}`;
  const js = (script, args = []) => wd('POST', `${S}/execute/sync`, { script, args });
  const jsAsync = (script, args = []) => wd('POST', `${S}/execute/async`, { script, args });
  const bild = async (name) => writeFileSync(join(OUT, name), Buffer.from(await wd('GET', `${S}/screenshot`), 'base64'));
  await wd('POST', `${S}/window/rect`, { width: 1280, height: 800 }).catch(() => {});
  await sleep(2500);

  pruefe((await js('return document.getElementById("version").textContent')) === 'Version 1.2.0', 'Version aus der App');
  await bild('1-start.png');
  // die App merkt sich den Standort – fuer den Test immer mit Segeberg beginnen
  await js('document.getElementById("st-segeberg").click()');

  // Ablegen wie per Drag & Drop: gleiches Ereignis, das Tauri beim Loslassen sendet
  const ergebnis = await jsAsync(`
    const fertig = arguments[arguments.length - 1];
    window.__TAURI__.event.emitTo({ kind: 'Webview', label: 'main' }, 'tauri://drag-drop', { paths: arguments[0], position: { x: 100, y: 100 } })
      .then(() => fertig('ok'), (e) => fertig('fehler: ' + e));
  `, [[ORDNER]]);
  pruefe(ergebnis === 'ok', 'Ablege-Ereignis gesendet');
  await sleep(4000);
  const zeilen = await js('return [...document.querySelectorAll(".zeile")].map((z) => z.innerText.replace(/\\s*\\n+\\s*/g, " | "))');
  console.log(zeilen.join('\n'));
  pruefe(zeilen.length === 7, `7 Nachweise aus Ordner, Unterordner und ZIP (${zeilen.length})`);
  pruefe(zeilen.some((z) => z.includes('Begleitkind_Oktober.pdf') && z.includes('1,40') && z.includes('32,23')), 'Oktober 1,40 / 32,23');
  pruefe(zeilen.some((z) => z.includes('kein Platz')), 'Fehlerfall angezeigt');
  const status = await js('return document.getElementById("status").textContent');
  console.log('Status:', status);
  await sleep(1500);
  await bild('2-liste.png');

  // zweiten Nachweis waehlen, Vorschau abwarten
  await js('document.querySelectorAll(".zeile")[2].click()');
  await sleep(2500);
  const canvas = await js('const c = document.querySelector(".vorschau canvas"); return c ? c.width : 0');
  pruefe(canvas > 100, 'Vorschau (pdf.js) gezeichnet');
  await bild('3-vorschau.png');

  // Speichern
  await js('document.getElementById("btn-speichern").click()');
  await sleep(2500);
  const nachher = await js('return document.getElementById("status").textContent');
  console.log('Status nach Speichern:', nachher);
  const erwartet = [
    join(ORDNER, 'Begleitkind_Oktober_ergaenzt.pdf'),
    join(ORDNER, 'Sammel_ergaenzt.pdf'),
    join(ORDNER, 'Export_ergaenzt', 'Teilmonat_ergaenzt.pdf'),
    join(ORDNER, 'Export_ergaenzt', 'Muster_ergaenzt.pdf'),
  ];
  for (const p of erwartet) pruefe(existsSync(p), 'gespeichert: ' + p.replace(ORDNER, '…'));
  pruefe(!existsSync(join(ORDNER, 'Unterordner', 'Langer_ergaenzt.pdf')), 'Fehlerfall nicht gespeichert');
  // gespeicherte Datei ist das Original plus Ergaenzung und wird als bereits ergaenzt erkannt
  const orig = readFileSync(join(F, '07_alt_nur_summe.pdf'));
  const neu = readFileSync(erwartet[0]);
  pruefe(neu.subarray(0, orig.length).equals(orig), 'Original-Bytes unverändert');
  const r2 = verarbeite(new Uint8Array(neu), 'segeberg');
  pruefe(r2.nachweise[0].status === 'bereitsErgaenzt' && r2.nachweise[0].gesamtText === '32,23', 'Ergebnis enthält 1,40 / 32,23');
  await bild('4-gespeichert.png');

  // Standort wechseln
  await js('document.getElementById("st-pinneberg").click()');
  await sleep(1500);
  const zp = await js('return [...document.querySelectorAll(".zeile")].map((z) => z.innerText.replace(/\\s*\\n+\\s*/g, " | "))');
  pruefe(zp.some((z) => z.includes('Begleitkind_Oktober.pdf') && z.includes('6,17') && z.includes('37,00')), 'Pinneberg 6,17 / 37,00');
  await bild('5-pinneberg.png');

  // Ansicht Mitarbeiter (Werte fuer das Stundenkonto)
  await js('document.getElementById("ans-mitarbeiter").click()');
  await sleep(800);
  const ma = await js('return [...document.querySelectorAll(".zeile")].map((z) => z.innerText.replace(/\\s*\\n+\\s*/g, " | "))');
  console.log(ma.join('\n'));
  pruefe(ma.length >= 3 && ma.some((z) => z.startsWith('Schulbegleiter, Max | Oktober 2026')), 'Mitarbeiter-Ansicht mit Monatswerten');
  pruefe((await js('return document.querySelector(".buchung") ? document.querySelector(".buchung").innerText : ""')).includes('Buchungswert'), 'Buchungswerte angezeigt');
  await bild('6-mitarbeiter.png');
} catch (e) {
  fehler++;
  console.log('ABBRUCH:', e.message);
} finally {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => {});
  treiber.kill();
}
console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
