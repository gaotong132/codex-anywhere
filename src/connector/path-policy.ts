import { posix, win32 } from 'node:path';

export function isPathWithinRoot(path: string, root: string) {
  const api = win32.isAbsolute(path) || win32.isAbsolute(root) ? win32 : posix;
  const difference = api.relative(api.resolve(root), api.resolve(path));
  return difference === ''
    || (difference !== '..' && !difference.startsWith(`..${api.sep}`) && !api.isAbsolute(difference));
}
