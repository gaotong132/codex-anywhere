import type { Nodes, Root } from 'mdast';

// Recognize only bare line-break tags. Other HTML stays escaped by ReactMarkdown;
// code nodes are untouched, and no raw-HTML parser or attributes are enabled.
export function remarkLineBreaks() {
  return (tree: Root) => {
    function walk(node: Nodes) {
      if (!('children' in node)) return;
      node.children = node.children.map(child => {
        if (child.type === 'html' && /^<br\s*\/?>$/i.test(child.value.trim())) {
          return { type: 'break', position: child.position };
        }
        walk(child);
        return child;
      }) as typeof node.children;
    }
    walk(tree);
  };
}
