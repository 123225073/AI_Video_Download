import fs from 'node:fs';
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
fs.writeFileSync('cli/version.json', JSON.stringify({ version }) + '\n');
