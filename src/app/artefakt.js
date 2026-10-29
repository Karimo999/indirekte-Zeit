// Testversion im Browser (claude.ai-Artefakt): Dateien per Auswahl/Ablegen, Speichern als Download.
import { zipSync } from 'fflate';
import { starte, istErgaenzt } from './ui.js';

/* global __VERSION__ */
const PDFJS = '4.10.38';

async function ausFiles(files) {
  const dateien = [];
  const fehler = [];
  for (const f of files) {
    const name = f.name || 'Datei.pdf';
    if (!/\.(pdf|zip|xlsx)$/i.test(name)) { fehler.push(`${name} ist keine PDF-, Excel- oder ZIP-Datei.`); continue; }
    if (istErgaenzt(name)) continue;
    try {
      dateien.push({ name, bytes: new Uint8Array(await f.arrayBuffer()), quelle: {}, schluessel: `${name}|${f.size}` });
    } catch (_) {
      fehler.push(`${name} konnte nicht gelesen werden.`);
    }
  }
  return { dateien, fehler };
}

/** abgelegte Dateien und Ordner lesen */
async function ausDrop(dt) {
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  const eintraege = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (!eintraege.some((e) => e && e.isDirectory)) return ausFiles([...dt.files]);
  const files = [];
  const lese = (entry) => new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) entry.file((f) => { files.push(f); resolve(); }, () => resolve());
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      const alle = [];
      const weiter = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const e of alle) await lese(e);
          resolve();
        } else {
          alle.push(...batch);
          weiter();
        }
      }, () => resolve());
      weiter();
    } else resolve();
  });
  for (const e of eintraege) await lese(e);
  return ausFiles(files.filter((f) => /\.(pdf|zip|xlsx)$/i.test(f.name)));
}

let downloadsCap;
function downloads() {
  if (downloadsCap === undefined) {
    downloadsCap = window.claude && typeof window.claude.use === 'function'
      ? window.claude.use('downloads').catch(() => null)
      : Promise.resolve(null);
  }
  return downloadsCap;
}

function herunterladen(name, bytes, typ) {
  const url = URL.createObjectURL(new Blob([bytes], { type: typ }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

starte({
  versionText: `Testversion ${__VERSION__}`,
  pdfjsQuellen: () => [
    { lib: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS}/legacy/build/pdf.min.mjs`, worker: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS}/legacy/build/pdf.worker.min.mjs` },
    { lib: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS}/pdf.min.mjs`, worker: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS}/pdf.worker.min.mjs` },
  ],
  oeffnen() {
    const eingabe = document.getElementById('datei-eingabe');
    return new Promise((resolve) => {
      let fertig = false;
      const ende = (wert) => {
        if (fertig) return;
        fertig = true;
        eingabe.removeEventListener('change', beiAuswahl);
        eingabe.removeEventListener('cancel', beiAbbruch);
        resolve(wert);
      };
      const beiAuswahl = () => {
        const files = [...eingabe.files];
        eingabe.value = '';
        ende(files.length ? ausFiles(files) : null);
      };
      const beiAbbruch = () => ende(null);
      eingabe.addEventListener('change', beiAuswahl);
      eingabe.addEventListener('cancel', beiAbbruch);
      eingabe.click();
    });
  },
  ziehenEinrichten(cb) {
    let tiefe = 0;
    const hatDateien = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hatDateien(e)) return;
      e.preventDefault();
      tiefe++;
      cb.hinein();
    });
    window.addEventListener('dragover', (e) => { if (hatDateien(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => {
      tiefe = Math.max(0, tiefe - 1);
      if (!tiefe) cb.hinaus();
    });
    window.addEventListener('drop', (e) => {
      if (!hatDateien(e)) return;
      e.preventDefault();
      tiefe = 0;
      const dt = e.dataTransfer;
      cb.ablegen(() => ausDrop(dt));
    });
  },
  async speichern(liste) {
    const dl = await downloads();
    let name, daten, typ;
    if (liste.length === 1) {
      name = liste[0].name;
      daten = liste[0].daten.slice();
      typ = 'application/pdf';
    } else {
      const inhalt = {};
      for (const e of liste) inhalt[e.name] = [e.daten, { level: 0 }];
      name = 'Leistungsnachweise_ergaenzt.zip';
      daten = zipSync(inhalt);
      typ = 'application/zip';
    }
    try {
      if (dl) await dl.save({ filename: name, data: daten });
      else herunterladen(name, daten, typ);
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.code === 'declined')) return null;
      throw new Error('Speichern hat nicht geklappt.');
    }
    return {
      gespeichert: liste.map((e) => ({ datei: e.datei, ziel: true })),
      fehler: [],
      text: liste.length === 1 ? `Heruntergeladen: ${name}` : `${liste.length} Dateien als ZIP heruntergeladen`,
    };
  },
});
