/** Preserve the path of a native user image without forwarding its base64 body. */
export function userImageAttachment(content: unknown): { path: string; name: string } | undefined {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    const path = item?.type === 'localImage' ? item.path
      : typeof item?.text === 'string' ? /<image\b[^>]*\bpath="([^"]+)"/i.exec(item.text)?.[1] : undefined;
    if (typeof path === 'string' && path.length <= 4096 && !/[\u0000-\u001f]/.test(path)) {
      return { path, name: path.split(/[\\/]/).at(-1) || 'image' };
    }
  }
}
