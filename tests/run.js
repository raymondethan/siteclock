const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
globalThis.backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
for (const file of ['content.js', 'popup.js']) {
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw Error('Expected Manifest V3');
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'suite.js'), 'utf8'), { filename: 'suite.js' });
globalThis.testCompletion.then(() => {
  if (globalThis.testFailures) process.exitCode = 1;
});
