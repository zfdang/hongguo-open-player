const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Expand filenames here so Node 20 and Windows do not rely on shell globbing.
const files = fs.readdirSync(path.join(__dirname, 'unit'))
  .filter(name => name.endsWith('.test.js')).sort()
  .map(name => path.join(__dirname, 'unit', name));
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' }
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
