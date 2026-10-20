import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// Read only the two public settings. Never evaluate the systemd EnvironmentFile.
const [file, requestedId, requestedLabel] = process.argv.slice(2);
let source = '';
try { source = readFileSync(file, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
function existing(key) {
  const line = source.split(/\r?\n/).find(value => value.startsWith(key + '='));
  if (!line) return '';
  const value = line.slice(key.length + 1);
  return value.startsWith('"') ? JSON.parse(value) : value;
}
const id = requestedId || existing('BRIDGE_DEVICE_ID') || `node-${randomUUID()}`;
const label = requestedLabel || existing('BRIDGE_DEVICE_LABEL') || hostname();
if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('invalid_device_id');
if (!label.trim() || label.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(label)) throw new Error('invalid_device_label');
process.stdout.write(`${id}\n${label.trim()}\n`);
