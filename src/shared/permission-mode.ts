export const PERMISSION_MODES = ['ask', 'auto', 'full'] as const;

export type PermissionMode = typeof PERMISSION_MODES[number];

export function normalizePermissionMode(value: unknown): PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode) ? value as PermissionMode : 'ask';
}
