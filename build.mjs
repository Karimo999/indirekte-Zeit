// Baut die Oberflaeche:
//   dist/desktop/      – fuer die Desktop-App (Tauri, Mac und Windows)
//   dist/artefakt.html – Testversion als Einzeldatei fuer den Browser
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const PDFJS_DIR = join(ROOT, 'node_modules/pdfjs-dist/legacy/build');

async function bundle(eintrag) {
  const r = await build({
    entryPoints: [join(ROOT, 'src/app', eintrag)],
    bundle: true,
    format: 'iife',
    minify: true,
    target: ['es2020', 'safari15'],
    write: false,
    legalComments: 'none',
    logLevel: 'warning',
    define: { __VERSION__: JSON.stringify(VERSION) },
  });
  return r.outputFiles[0].text;
}

const css = readFileSync(join(ROOT, 'src/app/styles.css'), 'utf8');
const body = readFileSync(join(ROOT, 'src/app/body.html'), 'utf8');
const lizenzen = [
  'Indirekte Zeit verwendet folgende freie Bausteine:',
  '',
  '- Tauri (Desktop-Rahmen), MIT/Apache License 2.0',
  '- pdf.js (Vorschau), Mozilla Foundation, Apache License 2.0',
  '- fflate (ZIP), Arjun Barrett, MIT License',
  '- Schrift Lato 2.015 (Teilmengen fuer eingetragene Werte), Łukasz Dziedzic, SIL Open Font License 1.1',
  '',
].join('\n');

// ------------------------------------------------------------ Desktop
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
const OUT = join(ROOT, 'dist/desktop');
mkdirSync(join(OUT, 'vendor'), { recursive: true });
writeFileSync(join(OUT, 'app.js'), await bundle('desktop.js'));
writeFileSync(join(OUT, 'styles.css'), css);
copyFileSync(join(PDFJS_DIR, 'pdf.min.mjs'), join(OUT, 'vendor/pdf.min.mjs'));
copyFileSync(join(PDFJS_DIR, 'pdf.worker.min.mjs'), join(OUT, 'vendor/pdf.worker.min.mjs'));
copyFileSync(join(ROOT, 'node_modules/pdfjs-dist/LICENSE'), join(OUT, 'vendor/LICENSE-pdfjs.txt'));
copyFileSync(join(ROOT, 'assets/fonts/OFL-Lato.txt'), join(OUT, 'vendor/OFL-Lato.txt'));
writeFileSync(join(OUT, 'LIZENZEN.txt'), lizenzen);
writeFileSync(join(OUT, 'index.html'), `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Indirekte Zeit</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
${body}
<script src="app.js"></script>
</body>
</html>
`);

// ------------------------------------------------------------ Testversion (Einzeldatei)
const artJs = await bundle('artefakt.js');
writeFileSync(join(ROOT, 'dist/artefakt.html'), `<title>Indirekte Zeit</title>
<style>
${css}
</style>
${body}
<script>
${artJs.replace(/<\/script/gi, '<\\/script')}
</script>
`);

console.log(`Version ${VERSION}: dist/desktop/ und dist/artefakt.html gebaut`);
