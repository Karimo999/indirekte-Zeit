// Prueft den Update-Weg der echten App (Linux-AppImage) gegen einen lokalen Update-Server:
// 1. falsche Signatur -> Update wird abgelehnt, Fehlermeldung
// 2. richtige Signatur -> Update wird geladen, geprueft, installiert, App startet neu
// 3. neu gestartete App meldet die neue Version
// Aufruf: node test/e2e-update-linux.mjs <arbeitsordner>
// Im Arbeitsordner: alt.AppImage (1.1.0, Endpunkt http://127.0.0.1:8899/latest.json),
// server/neu.AppImage (1.1.1), latest-gut.json, latest-falsch.json
import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { join, extname } from 'node:path';

const U = process.argv[2];
const APP = join(U, 'test', 'Indirekte.AppImage');
mkdirSync(join(U, 'test'), { recursive: true });
copyFileSync(join(U, 'alt.AppImage'), APP);
chmodSync(APP, 0o755);

let latest = 'latest-falsch.json';
const server = http.createServer((req, res) => {
  if (req.url === '/latest.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(readFileSync(join(U, latest)));
  }
  const p = join(U, 'server', req.url.replace(/^\//, ''));
  try {
    const d = readFileSync(p);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': d.length });
    res.end(d);
  } catch (_) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8899, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
const WD = 'http://127.0.0.1:4444';
async function wd(method, pfad, body) {
  const r = await fetch(WD + pfad, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${pfad}: ${j.value.error} ${j.value.message}`);
  return j.value;
}
let fehler = 0;
const pruefe = (bed, text) => { if (!bed) { fehler++; console.log('FEHLER: ' + text); } else console.log('ok: ' + text); };

const treiber = spawn('tauri-driver', [], { stdio: 'ignore', env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' } });
await sleep(1500);
async function sitzung(fn) {
  const s = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
  const S = `/session/${s.sessionId}`;
  const js = (script) => wd('POST', `${S}/execute/sync`, { script, args: [] });
  try { await fn(js, S); } finally { await wd('DELETE', S).catch(() => {}); }
}
const warteAuf = async (js, script, ms = 20000) => {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const v = await js(script).catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  return null;
};

try {
  // 1. falsche Signatur
  await sitzung(async (js) => {
    pruefe((await warteAuf(js, 'return document.getElementById("version").textContent')) === 'Version 1.1.0', 'alte App meldet 1.1.0');
    const text = await warteAuf(js, 'const u = document.getElementById("update"); return u.hidden ? null : document.getElementById("update-text").textContent');
    pruefe(text === 'Version 1.1.1 ist verfügbar.', `Update angeboten (${text})`);
    await js('document.getElementById("btn-update").click()');
    const meldung = await warteAuf(js, 'const t = document.getElementById("update-text").textContent; return t.includes("nicht installiert") ? t : null', 60000);
    pruefe(!!meldung, 'falsche Signatur abgelehnt: ' + meldung);
  });
  pruefe(hash(APP) === hash(join(U, 'alt.AppImage')), 'App-Datei unverändert nach abgelehntem Update');

  // 2. richtige Signatur
  latest = 'latest-gut.json';
  await sitzung(async (js) => {
    const text = await warteAuf(js, 'const u = document.getElementById("update"); return u.hidden ? null : document.getElementById("update-text").textContent');
    pruefe(text === 'Version 1.1.1 ist verfügbar.', 'Update angeboten');
    await js('document.getElementById("btn-update").click()');
    await sleep(15000);
  });
  pruefe(hash(APP) === hash(join(U, 'server', 'neu.AppImage')), 'App-Datei durch Version 1.1.1 ersetzt');

  // 3. neue Version startet
  await sitzung(async (js) => {
    pruefe((await warteAuf(js, 'return document.getElementById("version").textContent')) === 'Version 1.1.1', 'neue App meldet 1.1.1');
    await sleep(4000);
    pruefe(await js('return document.getElementById("update").hidden'), 'kein weiteres Update angeboten');
  });
} catch (e) {
  fehler++;
  console.log('ABBRUCH: ' + e.message);
} finally {
  treiber.kill();
  server.close();
}
console.log(fehler ? `\n${fehler} Fehler` : '\nUpdate-Weg in Ordnung');
process.exit(fehler ? 1 : 0);
