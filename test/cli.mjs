// Test-CLI fuer die JS-Engine (gleiche Ausgabe wie das Swift-CLI)
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { verarbeite } from '../src/engine/nachweis.js';

const args = process.argv.slice(2);
let standort = 'segeberg', outdir = null, json = false;
const files = [];
while (args.length) {
  const a = args.shift();
  if (a === '--standort') standort = args.shift();
  else if (a === '--outdir') outdir = args.shift();
  else if (a === '--json') json = true;
  else files.push(a);
}
const res = [];
for (const f of files) {
  const data = new Uint8Array(readFileSync(f));
  const t0 = performance.now();
  const r = verarbeite(data, standort);
  const ms = Math.round(performance.now() - t0);
  const fj = { file: basename(f), ms };
  if (r.fehler) fj.fehler = r.fehler;
  fj.nachweise = r.nachweise.map((n) => ({
    tage: n.anzahlTage, direkt: n.direktText || '', indirekt: n.indirektText || '', gesamt: n.gesamtText || '',
    status: n.status === 'bereit' ? 'bereit' : n.status === 'bereitsErgaenzt' ? 'bereits ergänzt' : 'fehler: ' + n.fehlertext,
    hinweise: n.hinweise, formel: n.formel,
  }));
  fj.eintragungen = r.eintragungen;
  if (r.ausgabe && outdir) {
    const target = join(outdir, basename(f).replace(/\.pdf$/i, '') + '_ergaenzt.pdf');
    writeFileSync(target, r.ausgabe);
    fj.ausgabe = target;
  }
  res.push(fj);
  if (!json) {
    console.log(`== ${fj.file} (${ms} ms)` + (fj.fehler ? `\n   FEHLER: ${fj.fehler}` : ''));
    for (const n of fj.nachweise) console.log(`   ${n.tage}T direkt ${n.direkt} indirekt ${n.indirekt} gesamt ${n.gesamt} [${n.formel || ''}] -> ${n.status}`);
    for (const e of r.eintragungen) console.log(`      S.${e.seite + 1} x=${e.x.toFixed(2)} y=${e.y.toFixed(2)} ${e.text} (${e.schrift} ${e.groesse})`);
  }
}
if (json) console.log(JSON.stringify(res, null, 1));
