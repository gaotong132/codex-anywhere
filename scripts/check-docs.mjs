import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const version = json('package.json').version;
const lock = json('package-lock.json');
assert.equal(lock.version, version, 'lockfile version');
assert.equal(lock.packages[''].version, version, 'lockfile root package version');
assert.equal(json('extension/manifest.json').version, version, 'extension version');
assert.equal(read('src/browser-control/mcp-server.ts').match(/name: 'anywhere-browser', version: '([^']+)'/)?.[1], version, 'MCP version');

const listed = args => execFileSync('git', ['ls-files', '-z', ...args, '*.md'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const files = [...new Set([...listed([]), ...listed(['--others', '--exclude-standard'])])]
  .filter(file => !/(^|\/)AGENTS\.md$/.test(file));
const issues = [];
const prose = text => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
const anchors = new Map();
function headings(file) {
  if (anchors.has(file)) return anchors.get(file);
  const seen = new Map();
  const ids = new Set([...prose(read(file)).matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    const slug = match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(slug) || 0;
    seen.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
  anchors.set(file, ids);
  return ids;
}
for (const file of files) {
  const text = prose(read(file));
  for (const match of text.matchAll(/\]\(([^\n]+?)\)|\b(?:src|href)="([^"]+)"/g)) {
    const target = (match[1] || match[2]).trim().replace(/^<|>$/g, '').split(/\s+"/)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const [pathname, anchor] = target.split('#');
    const resolved = pathname ? resolve(dirname(file), decodeURIComponent(pathname)) : resolve(file);
    if (!existsSync(resolved)) issues.push(`${file}: missing ${target}`);
    else if (anchor && /\.md$/i.test(resolved) && !headings(resolved).has(decodeURIComponent(anchor))) {
      issues.push(`${file}: missing heading ${target}`);
    }
  }
}
const entrypoints = ['README.md', 'README.zh-CN.md', 'docs/README.md', 'docs/README.zh-CN.md',
  ...['deployment', 'SECURITY', 'CONTRIBUTING', 'browser-agent'].flatMap(name => [`docs/${name}.md`, `docs/${name}.zh-CN.md`]),
  'extension/README.md', 'extension/README.zh-CN.md'];
for (const file of entrypoints) {
  if (!read(file).split('\n').slice(0, 6).join('\n').includes(`v${version}`)) issues.push(`${file}: stale version header`);
}
assert.deepEqual(issues, [], 'Documentation validation');
console.log(`Checked ${files.length} Markdown documents and v${version} release metadata.`);
