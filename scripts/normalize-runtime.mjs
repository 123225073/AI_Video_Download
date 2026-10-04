// Re-materialize this project's generated dependency files with normal file IO.
// Atomic replacement prevents altering the shared pnpm cache through hard links.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('node_modules');
let count = 0;
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(json|js|cjs|mjs)$/.test(entry.name)) {
      const data = fs.readFileSync(file);
      const temporary = `${file}.fengsha-normalize`;
      fs.writeFileSync(temporary, data); fs.renameSync(temporary, file); count++;
    }
  }
}
visit(root);
console.log(`Dependency files normalized: ${count}`);
