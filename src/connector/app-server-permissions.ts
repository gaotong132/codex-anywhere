import { basename } from 'node:path';
import { summarizeToolActivity } from '../shared/activity-detail.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import { resolveAllowedWorkspace } from './workspace-policy.js';

type JsonObject = Record<string, any>;

export type PendingApproval = {
  id: string | number;
  method: string;
  params: JsonObject;
  threadId: string;
  kind: string;
  summary: string;
};

export function approvalKind(method: string) {
  if (/commandExecution|execCommand/i.test(method)) return 'command';
  if (/fileChange|applyPatch/i.test(method)) return 'file-change';
  if (/permissions/i.test(method)) return 'permission';
  if (/requestUserInput/i.test(method)) return 'user-input';
  return 'action';
}

export function approvalSummary(method: string, params: JsonObject, limit = 4_000) {
  const value = params.command || params.reason || params.grantRoot || params.permissions
    || params.path || params.input || method;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, limit);
}

export function approvalDecisionSummary(pending: PendingApproval) {
  if (pending.kind === 'command') {
    return summarizeToolActivity({
      type: 'commandExecution',
      command: pending.params.command,
      parsed_cmd: pending.params.parsedCommand || pending.params.parsed_cmd,
    }) || 'command';
  }
  if (pending.kind === 'file-change') {
    const path = String(pending.params.path || pending.params.filePath || '').trim();
    return path ? `file-change · ${basename(path)}` : 'file-change';
  }
  return pending.kind;
}

export function approvalResult(
  method: string,
  approved: boolean,
  params: JsonObject = {},
  allowedRoots: string[] = [],
  networkAccess = false,
) {
  if (/permissions\/requestApproval/i.test(method)) {
    return approved
      ? { permissions: approvedPermissions(params.permissions, allowedRoots, networkAccess), scope: 'turn' }
      : { permissions: {}, scope: 'turn' };
  }
  if (/applyPatchApproval|execCommandApproval/i.test(method)) {
    return {
      decision: approved ? 'approved' : { denied: { rejection: 'Rejected from Codex Anywhere' } },
    };
  }
  return { decision: approved ? 'accept' : 'decline' };
}

export function approvedPermissions(
  requested: JsonObject = {},
  allowedRoots: string[],
  networkAccess: boolean,
) {
  const permissions: JsonObject = {};
  const requestedFileSystem = requested?.fileSystem;
  if (requestedFileSystem && typeof requestedFileSystem === 'object') {
    const read = filterAllowedPaths(requestedFileSystem.read, allowedRoots);
    const write = filterAllowedPaths(requestedFileSystem.write, allowedRoots);
    const entries = (Array.isArray(requestedFileSystem.entries) ? requestedFileSystem.entries : [])
      .flatMap((entry: JsonObject) => {
        if (entry?.path?.type !== 'path') return [];
        try {
          const path = resolveAllowedWorkspace(allowedRoots, entry.path.path);
          return [{ ...entry, path: { ...entry.path, path } }];
        } catch {
          return [];
        }
      });
    if (read.length || write.length || entries.length) {
      permissions.fileSystem = {
        read: read.length ? read : null,
        write: write.length ? write : null,
        ...(entries.length ? { entries } : {}),
      };
    }
  }
  if (networkAccess && requested?.network?.enabled === true) {
    permissions.network = { enabled: true };
  }
  return permissions;
}

export function permissionSettings(mode: PermissionMode, cwd: string, networkAccess: boolean) {
  if (mode === 'full') {
    return {
      thread: {
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access',
        config: { sandbox_mode: 'danger-full-access' },
      },
      turn: {
        approvalPolicy: 'never', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    };
  }
  return {
    thread: {
      approvalPolicy: 'on-request',
      approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
      sandbox: 'workspace-write',
      config: {
        sandbox_mode: 'workspace-write',
        sandbox_workspace_write: {
          writable_roots: [cwd],
          network_access: networkAccess,
          exclude_tmpdir_env_var: false,
          exclude_slash_tmp: false,
        },
      },
    },
    turn: {
      approvalPolicy: 'on-request',
      approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
      sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: [cwd], networkAccess,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    },
  };
}

function filterAllowedPaths(values: unknown, allowedRoots: string[]) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .flatMap((value) => {
      if (!value) return [];
      try { return [resolveAllowedWorkspace(allowedRoots, value)]; } catch { return []; }
    });
}
