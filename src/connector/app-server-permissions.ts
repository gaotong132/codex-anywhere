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

// Only the host's empty MCP approval form can use our approve/deny UI. Never
// reinterpret arbitrary elicitation forms (credentials, URLs, custom inputs).
export function isMcpToolApproval(method: string, params: JsonObject) {
  if (method === 'mcpServer/elicitation/request') {
    const schema = params.requestedSchema;
    return params.mode === 'form' && params._meta?.codex_approval_kind === 'mcp_tool_call'
      && schema?.type === 'object' && schema.properties && typeof schema.properties === 'object'
      && !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0
      && (!schema.required || (Array.isArray(schema.required) && schema.required.length === 0));
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = params.questions;
    return Array.isArray(questions) && questions.length === 1
      && typeof questions[0].id === 'string' && questions[0].id.startsWith('mcp_tool_call_approval')
      && questions[0].options?.some((option: JsonObject) => option.label === 'Allow')
      && questions[0].options?.some((option: JsonObject) => option.label === 'Cancel');
  }
  return false;
}

export function approvalKind(method: string) {
  if (method === 'mcpServer/elicitation/request' || method === 'item/tool/requestUserInput') return 'mcp-tool';
  if (/commandExecution|execCommand/i.test(method)) return 'command';
  if (/fileChange|applyPatch/i.test(method)) return 'file-change';
  if (/permissions/i.test(method)) return 'permission';
  if (/requestUserInput/i.test(method)) return 'user-input';
  return 'action';
}

export function approvalSummary(method: string, params: JsonObject, limit = 4_000) {
  if (isMcpToolApproval(method, params)) {
    return `${params.serverName || 'MCP'} · ${params.message || params.questions[0].question || 'Tool approval'}\n${JSON.stringify(params._meta?.tool_params || {})}`.slice(0, limit);
  }
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
  if (isMcpToolApproval(method, params)) {
    if (method === 'mcpServer/elicitation/request') return { action: approved ? 'accept' : 'decline', content: approved ? {} : null, _meta: null };
    return { answers: { [params.questions[0].id]: { answers: [approved ? 'Allow' : 'Cancel'] } } };
  }
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
