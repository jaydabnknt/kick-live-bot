// Puts src/app.html into worker.js (as APP_HTML), so the whole bot stays one file.
// Run after editing src/app.html:  node scripts/build-app.mjs
import fs from 'node:fs';
const root = new URL('..', import.meta.url);
const html = fs.readFileSync(new URL('src/app.html', root), 'utf8');
const file = new URL('worker.js', root);
const w = fs.readFileSync(file, 'utf8');
const a = w.indexOf('// APP_HTML_START'), b = w.indexOf('// APP_HTML_END');
if (a < 0 || b < 0) throw new Error('APP_HTML markers not found in worker.js');
const out = w.slice(0, a) + '// APP_HTML_START (generated from src/app.html by scripts/build-app.mjs)\nconst APP_HTML = ' + JSON.stringify(html) + ';\n' + w.slice(b);
fs.writeFileSync(file, out);
console.log('worker.js updated');
