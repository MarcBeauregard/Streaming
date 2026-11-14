// Copies the two browser players out of node_modules into public/vendor/,
// where the app serves them. Runs after every `npm install`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');
mkdirSync(out, { recursive: true });
copyFileSync(join(root, 'node_modules', 'hls.js', 'dist', 'hls.min.js'), join(out, 'hls.min.js'));
copyFileSync(join(root, 'node_modules', 'dashjs', 'dist', 'modern', 'umd', 'dash.all.min.js'), join(out, 'dash.min.js'));
