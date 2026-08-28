export function localFilePathFromHref(href?: string) {
  if (!href) return null;
  let value = href.trim();
  try { value = decodeURIComponent(value); } catch { return null; }
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  } else if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.origin !== location.origin) return null;
      value = decodeURIComponent(url.pathname);
    } catch { return null; }
  }
  value = value.replace(/[?#].*$/, '');
  if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  if (!/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\[^\\]/.test(value)) return null;
  return value.replace(/:\d+$/, '').replace(/\//g, '\\');
}

export function localFileName(path: string) {
  return path.split(/[\\/]/).at(-1) || '本机文件';
}

export function safeDownloadName(value: string) {
  return String(value || 'download').replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 180) || 'download';
}

export function decodeBase64Chunk(value: string) {
  if (!value || value.length > 600_000 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('download_chunk_invalid');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
