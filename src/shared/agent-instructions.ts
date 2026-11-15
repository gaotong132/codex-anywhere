export type AgentInstructions = {
  body: string;
  scope?: string;
};

// Only complete, standalone Desktop instruction messages qualify. Quoted
// examples, incomplete envelopes and instructions followed by prose stay text.
export function parseAgentInstructions(text: string): AgentInstructions | null {
  const heading = /^# AGENTS\.md instructions(?:[ \t]+for[ \t]+([^\r\n]+))?[ \t]*\r?\n(?:[ \t]*\r?\n)*/i.exec(text);
  if (!heading) return null;
  const envelope = text.slice(heading[0].length);
  for (const [opening, closing] of [
    ['<INSTRUCTIONS>', '</INSTRUCTIONS>'],
    ['\\<INSTRUCTIONS>', '\\</INSTRUCTIONS>'],
    ['&lt;INSTRUCTIONS&gt;', '&lt;/INSTRUCTIONS&gt;'],
  ]) {
    if (envelope.startsWith(opening) && envelope.endsWith(closing)) {
      return { body: envelope.slice(opening.length, -closing.length).trim(), scope: heading[1]?.trim() || undefined };
    }
  }
  return null;
}
