import type { Heading, Nodes, Paragraph, PhrasingContent, Root } from 'mdast';

/** File reading keeps authored line breaks and accepts compact ATX headings. */
export function remarkMarkdownFile() {
  return (tree: Root, file: { value: unknown }) => {
    const sourceLines = String(file.value).split(/\r\n|\n|\r/);

    function splitHeadings(paragraph: Paragraph): (Paragraph | Heading)[] {
      const lines: { children: PhrasingContent[]; sourceLine?: number }[] = [{ children: [] }];
      for (const child of paragraph.children) {
        if (child.type === 'break') {
          lines.push({ children: [] });
        } else if (child.type === 'text') {
          child.value.split(/\r\n|\n|\r/).forEach((value, index) => {
            if (index) lines.push({ children: [] });
            const line = lines.at(-1)!;
            if (!line.children.length && child.position) line.sourceLine = child.position.start.line + index;
            if (value) line.children.push({ type: 'text', value });
          });
        } else {
          lines.at(-1)!.children.push(child);
        }
      }
      const blocks: (Paragraph | Heading)[] = [];
      let current: Paragraph | undefined;
      for (const line of lines) {
        const first = line.children[0];
        // Check the original source as well: escaped hashes and code stay literal.
        const match = line.sourceLine === undefined ? null
          : /^ {0,3}(#{1,6})(?=[\p{L}\p{N}])/u.exec(sourceLines[line.sourceLine - 1] || '');
        if (match && first?.type === 'text' && first.value.startsWith(match[1])) {
          blocks.push({ type: 'heading', depth: match[1].length as Heading['depth'],
            children: [{ type: 'text', value: first.value.slice(match[1].length) }, ...line.children.slice(1)] });
          current = undefined;
        } else {
          if (!current) {
            current = { type: 'paragraph', children: [] };
            blocks.push(current);
          } else current.children.push({ type: 'break' });
          current.children.push(...line.children);
        }
      }
      return blocks;
    }

    function walk(node: Nodes) {
      if (!('children' in node)) return;
      node.children = (node.children as Nodes[]).flatMap((child): Nodes[] => {
        if (child.type === 'paragraph') {
          const blocks = splitHeadings(child);
          blocks.forEach(walk);
          return blocks;
        }
        if (child.type === 'text') {
          return child.value.split(/\r\n|\n|\r/).flatMap((value, index): PhrasingContent[] => [
            ...(index ? [{ type: 'break' as const }] : []), { type: 'text', value },
          ]);
        }
        walk(child);
        return [child];
      }) as typeof node.children;
    }
    walk(tree);
  };
}
