import { realpathSync } from 'node:fs';
import {
  basename, dirname, isAbsolute, relative, resolve,
} from 'node:path';

export function resolveAllowedWorkspace(roots: string[] | string, candidate: unknown) {
  const rawCandidate = String(candidate || '').trim();
  if (!rawCandidate) throw new Error('project_directory_required');
  const requested = canonicalizeWorkspaceCandidate(rawCandidate);
  const allowedRoots = (Array.isArray(roots) ? roots : [roots])
    .map((root) => String(root || '').trim())
    .filter(Boolean)
    .flatMap((root) => {
      try { return [realpathSync(resolve(root))]; } catch { return []; }
    });
  for (const allowedRoot of allowedRoots) {
    const pathFromRoot = relative(allowedRoot, requested);
    if (!pathFromRoot || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
      return requested;
    }
  }
  throw new Error('workspace_outside_allowed_root');
}

function canonicalizeWorkspaceCandidate(candidate: string) {
  let current = resolve(candidate);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(current), ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('workspace_path_invalid');
      const parent = dirname(current);
      if (parent === current) throw new Error('workspace_path_invalid');
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

export function isAllowedWorkspace(roots: string[] | string, candidate: unknown) {
  try {
    resolveAllowedWorkspace(roots, candidate);
    return true;
  } catch {
    return false;
  }
}
