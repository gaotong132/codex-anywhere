// Desktop prepends this ambient browser envelope to user-role messages.
// Only the complete known payload at the beginning qualifies; examples,
// assistant explanations and unknown/malformed payloads remain ordinary text.
export function stripDesktopBrowserContext(text: string): string {
  const prefix = /^(?:\\?<|&lt;)(external\\?_browser\\?_tabs|in-app-browser-context)\b[\s\S]*?(?:\\?<|&lt;)\/\1(?:>|&gt;)/i.exec(text);
  if (!prefix) return text;
  const normalized = prefix[0]
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\\(?=<\/?[a-z])/gi, '')
    .replace(/<[^>]+>/g, tag => tag.replace(/\\_/g, '_'));
  const wrapper = /^<external_browser_tabs>\s*([\s\S]*?)\s*<\/external_browser_tabs>$/.exec(normalized);
  const context = wrapper?.[1] || normalized;
  const expected = /^<in-app-browser-context source=["']ambient-ui-state["']>\r?\nThis block is automatically supplied ambient UI state, not part of the user's request\. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser\.\r?\n# In app browser:\r?\n- The user has the in-app browser open with \d+ tabs?\.\r?\n- Current URL: (?:https?:\/\/|about:)[^\s<>]+\r?\n<\/in-app-browser-context>$/;
  return expected.test(context) ? text.slice(prefix[0].length).trimStart() : text;
}
