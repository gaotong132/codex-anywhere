import type { BrowserTarget } from '../../src/browser-control/contracts.js';

export const RECENT_CHILD_TABS = 3;

// Runs only inside the exact, already-authorized document. No field values leave
// the isolated world. Remember edits across grant rotation / worker reconnects.
function inspectDocument(grantId: string) {
  const scope = globalThis as typeof globalThis & {
    __anywhereBrowser?: { grantId: string };
    __anywhereTabEdits?: { edited: boolean; inspected: boolean };
  };
  if (scope.__anywhereBrowser?.grantId !== grantId) return { canClose: false };
  if (!scope.__anywhereTabEdits) {
    const edits = { edited: false, inspected: false };
    scope.__anywhereTabEdits = edits;
    // Install before inspecting existing controls, including older managed tabs.
    const remember = () => { edits.edited = true; };
    document.addEventListener('input', remember, true);
    document.addEventListener('change', remember, true);
    const controls = document.querySelectorAll('input,textarea,select,[contenteditable]');
    if (controls.length > 1000) edits.edited = true;
    for (const node of Array.from(controls).slice(0, 1000)) {
      if (node instanceof HTMLInputElement) {
        if (node.type !== 'hidden' && (node.value !== node.defaultValue || node.checked !== node.defaultChecked || node.files?.length)) edits.edited = true;
      } else if (node instanceof HTMLTextAreaElement) {
        if (node.value !== node.defaultValue) edits.edited = true;
      } else if (node instanceof HTMLSelectElement) {
        const options = Array.from(node.options);
        const explicitDefault = options.some((option) => option.defaultSelected);
        const implicitDefault = options.findIndex((option) => !option.disabled && !option.closest('optgroup[disabled]'));
        if (options.some((option, index) => option.selected !== (explicitDefault ? option.defaultSelected : !node.multiple && index === implicitDefault))) edits.edited = true;
      } else if (node.getAttribute('contenteditable') !== 'false') edits.edited = true;
    }
    edits.inspected = true;
  }
  return { canClose: scope.__anywhereTabEdits.inspected && !scope.__anywhereTabEdits.edited };
}

export async function canRetireTab(target: BrowserTarget, grantId: string) {
  try {
    const [proof] = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      world: 'ISOLATED', injectImmediately: true, func: inspectDocument, args: [grantId],
    });
    return proof?.documentId === target.documentId && proof.result?.canClose === true;
  } catch { return false; }
}
