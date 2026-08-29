const DETAIL_LIMIT = 140;

type ActivityValue = Record<string, any>;

export function summarizeToolActivity(value: ActivityValue) {
  const outer = value && typeof value === 'object' ? value : {};
  const item = outer.item && typeof outer.item === 'object' ? outer.item : outer;
  const type = String(item.type || outer.type || '');
  const name = String(item.name || item.toolName || outer.name || outer.toolName || '');
  const input = String(item.input || item.arguments || outer.input || outer.arguments || '');
  const query = firstText(item.query, outer.query, item.action?.query, outer.action?.query);

  if (/(?:custom_tool_call|function_call)_output/i.test(type)) return '';

  if (/web.?search/i.test(type) || /web.?search/i.test(name)) {
    return joinDetail('web_search', query);
  }
  if (/patch_apply|file_change/i.test(type) || /apply.?patch/i.test(name)) {
    return patchDetail(input, item.changes || outer.changes);
  }
  if (/image.?generation/i.test(type) || /image.?gen/i.test(name)) {
    return joinDetail(toolLabel(name || 'image_generation'));
  }
  if (/mcp.?tool/i.test(type)) {
    const invocation = item.invocation || outer.invocation || {};
    const server = firstText(invocation.server, item.server, outer.server);
    const tool = firstText(invocation.tool, invocation.name, name);
    return joinDetail('mcp', [server, tool].filter(Boolean).map(toolLabel).join('.'));
  }
  if (/command.?execution/i.test(type)) {
    const command = commandText(item.parsed_cmd, item.command, outer.parsed_cmd, outer.command);
    const exitCode = numericValue(item.exit_code, outer.exit_code);
    const detail = [safeCommandSummary(command), exitCode == null ? '' : `exit ${exitCode}`]
      .filter(Boolean).join(' · ');
    return joinDetail('command', detail);
  }
  if (/custom_tool_call|function_call|toolCall/i.test(type) || name) {
    const nestedTool = nestedToolName(input);
    const label = toolLabel(nestedTool || name || type);
    if (nestedTool === 'apply_patch') return patchDetail(input);
    if (nestedTool === 'web__run') return joinDetail('web.run', extractedString(input, 'q') || extractedString(input, 'query'));
    if (nestedTool === 'exec_command') return joinDetail('exec_command', safeCommandSummary(extractedString(input, 'cmd')));
    return joinDetail(label);
  }
  return '';
}

function patchDetail(input: string, changes?: unknown) {
  const paths = [...String(input || '').matchAll(/^\*{3} (?:Update|Add|Delete) File:\s*(.+)$/gm)]
    .map((match) => basename(match[1].trim()))
    .filter(Boolean);
  if (!paths.length && changes && typeof changes === 'object') {
    paths.push(...Object.keys(changes as Record<string, unknown>).map(basename).filter(Boolean));
  }
  const unique = [...new Set(paths)];
  const visible = unique.slice(0, 2).join(', ');
  const remainder = unique.length > 2 ? ` +${unique.length - 2}` : '';
  return joinDetail('apply_patch', `${visible}${remainder}`);
}

function nestedToolName(input: string) {
  return /\btools\.([A-Za-z0-9_]+)\s*\(/.exec(input)?.[1] || '';
}

function extractedString(input: string, key: string) {
  const match = new RegExp(`["']?${key}["']?\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'i').exec(input);
  if (!match) return '';
  try { return JSON.parse(match[1]); } catch { return ''; }
}

function safeCommandSummary(command: string) {
  const text = String(command || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const patterns = [
    /\bnpm\s+run\s+[\w:.-]+/ig,
    /\bnpm\s+(?:test|ci|install)\b/ig,
    /\bgit\s+(?:status|diff|log|show|add|commit|push|pull|fetch|rev-parse)\b/ig,
    /\bdocker\s+compose\s+(?:up|build|ps|logs|pull|restart)\b/ig,
    /\bkubectl\s+(?:apply|create|delete|describe|exec|get|logs|patch|rollout|scale|set|top|wait)\b/ig,
    /\bhelm\s+(?:install|list|rollback|status|test|uninstall|upgrade)\b/ig,
    /\b(?:df|du|free|journalctl|netstat|openssl|ping|ps|ss|systemctl|top|traceroute)\b/ig,
    /\b(?:Get-Content|Get-ChildItem|Get-CimInstance|Get-NetTCPConnection|Invoke-RestMethod|Invoke-WebRequest|Select-String|Start-Process|Stop-Process|Test-Path|Wait-Process)\b/ig,
    /\b(?:curl|node|npx|python|rg|ssh|tsc|tsx|vite)\b/ig,
  ];
  const matches = patterns.flatMap((pattern) => [...text.matchAll(pattern)]
    .map((match) => ({ index: match.index || 0, text: match[0] })))
    .sort((left, right) => left.index - right.index);
  return [...new Set(matches.map((match) => match.text))].slice(0, 2).join(' + ');
}

function commandText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (!Array.isArray(value)) continue;
    const structured = value
      .map((entry) => entry && typeof entry === 'object' ? String((entry as ActivityValue).cmd || '') : '')
      .filter(Boolean);
    if (structured.length) return structured.join('; ');
    const parts = value.map((entry) => typeof entry === 'string' ? entry : '').filter(Boolean);
    if (!parts.length) continue;
    const shellIndex = parts.findIndex((part) => /^(?:-c|-command)$/i.test(part));
    return (shellIndex >= 0 ? parts.slice(shellIndex + 1) : parts).join(' ');
  }
  return '';
}

function numericValue(...values: unknown[]) {
  for (const value of values) {
    const numeric = typeof value === 'number' ? value : Number.NaN;
    if (Number.isInteger(numeric)) return numeric;
  }
  return null;
}

function joinDetail(label: string, detail = '') {
  const text = [label, detail].filter(Boolean).join(' · ');
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT - 1).trimEnd()}…`;
}

function toolLabel(value: string) {
  return String(value || '').replace(/__+/g, '.').replace(/\s+/g, ' ').trim();
}

function basename(value: string) {
  return String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
}

function firstText(...values: unknown[]) {
  return values.map((value) => typeof value === 'string' ? value.trim() : '').find(Boolean) || '';
}

export const internals = { commandText, extractedString, nestedToolName, patchDetail, safeCommandSummary };
