// Build: bundle src/app.js (+ modules) into one IIFE and inline it, the CSS and
// a precomputed default-rules strategy chart into index.html.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { generateChart } from './src/strategy.js';
import { DEFAULT_RULES } from './src/engine.js';

// Build stamp shown in Settings (and a <meta>) so a phone can confirm it has the latest version.
const d = new Date(), pad = (n) => String(n).padStart(2, '0');
const BUILD = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const js = await build({ entryPoints: ['src/app.js'], define: { __BUILD__: JSON.stringify(BUILD) }, bundle: true, format: 'iife', target: ['safari15', 'edge100'], minify: false, write: false, legalComments: 'inline' });
const chart = await generateChart({ ...DEFAULT_RULES });
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v)));
let html = readFileSync('src/index.html', 'utf8');
html = html.replace('/*__CSS__*/', () => readFileSync('src/styles.css', 'utf8'))
  .replace('/*__CHART__*/null', () => JSON.stringify(round(chart)))
  .replace('</head>', () => `<meta name="build" content="${BUILD}">\n</head>`)
  .replace('/*__JS__*/', () => js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('build', BUILD, 'dist/index.html', (html.length / 1024).toFixed(0) + ' KB');
