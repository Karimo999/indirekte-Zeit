// Prueft die Rechen- und PDF-Logik an allen Testfaellen (beide Standorte).
// Aufruf: npm test
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verarbeite } from '../src/engine/nachweis.js';
import { PDFFile } from '../src/engine/file.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'faelle');
const erwartet = JSON.parse(readFileSync(join(DIR, 'erwartet.json'), 'utf8'));
const ERWARTETER_STATUS = {
  muster: 'bereit', summe: 'bereit', labels2: 'bereit', frei: 'bereit',
  alt: 'bereit', // heutiger Kilanka-Stand: Zeilen werden eingefuegt
  gefuellt: 'bereitsErgaenzt', strich: 'fehler', kein_platz: 'fehler',
};

let ok = 0;
let fehler = 0;
for (const standort of ['segeberg', 'pinneberg']) {
  for (const datei of readdirSync(DIR).filter((f) => f.endsWith('.pdf')).sort()) {
    const e = erwartet[datei];
    const data = new Uint8Array(readFileSync(join(DIR, datei)));
    const r = verarbeite(data, standort);
    const probleme = [];
    let status = ERWARTETER_STATUS[e.variant];
    // bereits ausgefuellte Datei enthaelt Segeberg-Werte -> unter Pinneberg Konflikt
    if (e.variant === 'gefuellt' && standort === 'pinneberg') status = 'fehler';
    if (r.nachweise.length !== e.nachweise.length) probleme.push(`Anzahl ${r.nachweise.length} statt ${e.nachweise.length}`);
    r.nachweise.forEach((n, i) => {
      const x = e.nachweise[i];
      if (!x) return;
      if (n.anzahlTage !== x.tage) probleme.push(`Tage ${n.anzahlTage} statt ${x.tage}`);
      if (n.direktText !== x.direkt) probleme.push(`direkt ${n.direktText} statt ${x.direkt}`);
      if (x.fachkraft && n.fachkraft !== x.fachkraft) probleme.push(`Fachkraft ${n.fachkraft} statt ${x.fachkraft}`);
      const soll = standort === 'pinneberg' && x.pinneberg ? x.pinneberg : x;
      if (soll.indirekt && n.indirektText !== soll.indirekt) probleme.push(`indirekt ${n.indirektText} statt ${soll.indirekt}`);
      if (soll.gesamt && n.gesamtText !== soll.gesamt) probleme.push(`gesamt ${n.gesamtText} statt ${soll.gesamt}`);
      if (n.status !== status) probleme.push(`Status ${n.status} statt ${status}`);
    });
    if (status === 'bereit') {
      if (!r.ausgabe) probleme.push('keine Ausgabe: ' + r.fehler);
      else {
        for (let i = 0; i < data.length; i++) if (r.ausgabe[i] !== data[i]) { probleme.push('Original-Bytes verändert'); break; }
        try { new PDFFile(r.ausgabe); } catch (err) { probleme.push('Ausgabe nicht lesbar'); }
        // zweiter Durchlauf: nichts doppelt eintragen
        const r2 = verarbeite(r.ausgabe, standort);
        if (r2.ausgabe || r2.nachweise.some((n) => n.status !== 'bereitsErgaenzt')) probleme.push('zweiter Durchlauf nicht „bereits ergänzt“');
      }
    } else if (r.ausgabe) probleme.push('unerwartete Ausgabe');
    if (probleme.length) {
      fehler++;
      console.log(`FEHLER ${standort.padEnd(9)} ${datei}: ${probleme.join('; ')}`);
    } else ok++;
  }
}
console.log(`\n${ok} von ${ok + fehler} Prüfungen bestanden`);
process.exit(fehler ? 1 : 0);
