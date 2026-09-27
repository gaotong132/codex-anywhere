export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 256 * 1024;

export type UploadedFile = { path: string; name: string; size: number; sha256: string };

export function safeUploadName(value: unknown) {
  const name = String(value || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '');
  let bounded = '';
  for (const character of name) {
    if (new TextEncoder().encode(bounded + character).length > 160) break;
    bounded += character;
  }
  return bounded.replace(/[. ]+$/g, '') || 'attachment.bin';
}
