export const MAX_SESSION_NAME_LENGTH = 100;

export function normalizeSessionName(value: unknown) {
  const name = String(value || '').trim();
  if (!name) throw new Error('session_name_required');
  if (Array.from(name).length > MAX_SESSION_NAME_LENGTH) throw new Error('session_name_too_long');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('session_name_invalid');
  return name;
}
