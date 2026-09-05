import { t } from './i18n';
import {
  describeTextPreviewFile,
  type TextPreviewDescriptor,
} from '../../src/shared/text-preview';

export function localFilePathFromHref(href?: string) {
  if (!href) return null;
  let value = href.trim();
  try { value = decodeURIComponent(value); } catch { return null; }
  const httpLink = /^https?:\/\//i.test(value);
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = decodeURIComponent(url.pathname);
    } catch { return null; }
  } else if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.origin !== location.origin) return null;
      value = decodeURIComponent(url.pathname);
    } catch { return null; }
  }
  value = value.replace(/[?#].*$/, '');
  if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  if (!httpLink && /^\/[^/]/.test(value)) return value.replace(/:\d+$/, '');
  if (!/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\[^\\]/.test(value)) return null;
  return value.replace(/:\d+$/, '').replace(/\//g, '\\');
}

export function localFileName(path: string) {
  return path.split(/[\\/]/).at(-1) || t('本机文件', 'Local file');
}

export function isMarkdownFilePath(path: string) {
  return /\.(?:md|markdown)$/i.test(String(path || '').trim());
}

export type LocalTextPreviewInfo = TextPreviewDescriptor;

export function localTextPreviewInfo(path: string): LocalTextPreviewInfo | null {
  return describeTextPreviewFile(localFileName(String(path || '')));
}

export function isTextPreviewFilePath(path: string) {
  return Boolean(localTextPreviewInfo(path));
}

export function localFilePathFromRelativeHref(href: string | undefined, basePath?: string) {
  if (!href || !basePath || !/^(?:[A-Za-z]:[\\/]|\/[^/])/.test(basePath)) return null;
  const value = href.trim();
  if (!value || value.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith('//')) {
    return null;
  }
  let decoded;
  try { decoded = decodeURIComponent(value).replace(/[?#].*$/, ''); } catch { return null; }
  if (!decoded) return null;
  if (basePath.startsWith('/')) {
    return decoded.startsWith('/') ? decoded : `${basePath.slice(0, basePath.lastIndexOf('/') + 1)}${decoded}`;
  }
  const separator = Math.max(basePath.lastIndexOf('\\'), basePath.lastIndexOf('/'));
  if (separator < 2) return null;
  return `${basePath.slice(0, separator + 1)}${decoded.replace(/\//g, '\\')}`;
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
