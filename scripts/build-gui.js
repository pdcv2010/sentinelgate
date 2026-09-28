const fs = require('fs');
const path = require('path');
const source = path.resolve(__dirname, '../GUI');
const output = process.argv[2];
const rootConfig = fs.readFileSync(path.resolve(__dirname, '../config.js'), 'utf8');
const serverUrlMatch = rootConfig.match(/^window\.SERVER_URL\s*=\s*("(?:\\.|[^"])*")\s*;?\s*$/m);
if (!serverUrlMatch) throw new Error('Root config.js must define window.SERVER_URL.');
const serverUrl = process.env.SERVER_URL || JSON.parse(serverUrlMatch[1]);
if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(serverUrl)) {
  throw new Error('SERVER_URL must be an HTTPS origin without a path.');
}
if (!output) throw new Error('Usage: node build-gui.js <SentinelGate_Client-directory>');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'GUI'), { recursive: true });
fs.writeFileSync(path.join(output, 'config.js'), `// Production HTTPS origin; API_BASE_URL is derived below.\nwindow.SERVER_URL = ${JSON.stringify(serverUrl)};\nwindow.API_BASE_URL = String(window.SERVER_URL).replace(/\\/+$/, \"\") + \"/api\";\n`);
for (const name of ['index.html', 'app.js', 'style.css', 'js', 'assets', 'font']) {
  fs.cpSync(path.join(source, name), path.join(output, 'GUI', name), { recursive: true });
}
