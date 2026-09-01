export type TextPreviewDescriptor = {
  kind: 'markdown' | 'code' | 'text';
  language: string;
};

const CODE_PREVIEW_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  bat: 'dos', bash: 'bash', c: 'c', cc: 'cpp', cjs: 'javascript', cmd: 'dos',
  cpp: 'cpp', cs: 'csharp', css: 'css', cxx: 'cpp', dart: 'dart', diff: 'diff',
  ex: 'elixir', exs: 'elixir', fs: 'fsharp', fsx: 'fsharp', go: 'go', gql: 'graphql',
  gradle: 'gradle', graphql: 'graphql', groovy: 'groovy', h: 'c', hpp: 'cpp', htm: 'xml',
  html: 'xml', hxx: 'cpp', ini: 'ini', java: 'java', js: 'javascript', json: 'json',
  jsonc: 'json', jsx: 'javascript', kt: 'kotlin', kts: 'kotlin', less: 'less', lua: 'lua',
  mjs: 'javascript', patch: 'diff', php: 'php', pl: 'perl', pm: 'perl', properties: 'properties',
  ps1: 'powershell', py: 'python', pyi: 'python', r: 'r', rb: 'ruby', rs: 'rust',
  sass: 'scss', scss: 'scss', sh: 'bash', sol: 'solidity', sql: 'sql', svelte: 'xml',
  svg: 'xml', swift: 'swift', tf: 'hcl', toml: 'ini', ts: 'typescript', tsx: 'typescript',
  vue: 'xml', xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'bash',
});

export function describeTextPreviewFile(name: string): TextPreviewDescriptor | null {
  const lowerName = String(name || '').toLowerCase();
  if (/\.(?:md|markdown)$/.test(lowerName)) return { kind: 'markdown', language: 'markdown' };
  if (lowerName === 'dockerfile') return { kind: 'code', language: 'dockerfile' };
  if (lowerName === 'makefile') return { kind: 'code', language: 'makefile' };
  if (lowerName === 'cmakelists.txt') return { kind: 'code', language: 'cmake' };
  if (/\.(?:txt|log|csv|tsv)$/.test(lowerName)) return { kind: 'text', language: 'plaintext' };
  const extension = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.') + 1) : '';
  const language = CODE_PREVIEW_LANGUAGES[extension];
  return language ? { kind: 'code', language } : null;
}
