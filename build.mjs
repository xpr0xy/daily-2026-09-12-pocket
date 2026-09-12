// Static build: copy the app into docs/ with relative-only asset paths.
import { mkdir, copyFile, readFile, rm } from 'node:fs/promises';

const files = ['index.html', 'style.css'];
const srcFiles = ['main.js', 'engine.js', 'render.js', 'dsp.js', 'pattern.js'];

await rm('docs', { recursive: true, force: true });
await mkdir('docs/src', { recursive: true });
for (const f of files) await copyFile(f, 'docs/' + f);
for (const f of srcFiles) await copyFile('src/' + f, 'docs/src/' + f);

const html = await readFile('docs/index.html', 'utf8');
if (/(?:src|href)="\/assets\//.test(html)) throw new Error('Absolute /assets path found in index.html');
if (!/data-product="POCKET"/.test(html)) throw new Error('Product marker missing');
if (!/src="\.\/src\/main\.js"/.test(html)) throw new Error('Module entry is not a relative path');

console.log('Built POCKET -> docs/ (' + (files.length + srcFiles.length) + ' files, relative paths, marker verified)');
