import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { t } from './i18n';
import { loadEnvironmentValue, storeEnvironmentValue } from './execution-environments';
import { normalizePermissionMode, type PermissionMode } from '../../src/shared/permission-mode';
import type { BridgeRequest } from './bridge-request-manager';
import type {
  ConnectorStatus,
  ModelConfigDraft,
  SessionModelConfig,
  SessionPermissionConfig,
} from './app-types';

export const SESSION_PERMISSION_MODE_KEY = 'bridge.permissionMode';

type KeyedValue<T> = { key: string; value: T };

export function useSessionConfiguration({
  environmentId,
  online,
  threadId,
  request,
}: {
  environmentId: string;
  online: boolean;
  threadId: string | null;
  request: BridgeRequest;
}) {
  const [modelState, setModelState] = useState<KeyedValue<SessionModelConfig | null> | null>(null);
  const [modelLoadingKey, setModelLoadingKey] = useState<string | null>(null);
  const [connectorState, setConnectorState] = useState<KeyedValue<ConnectorStatus | null> | null>(null);
  const [permissionState, setPermissionState] = useState<KeyedValue<SessionPermissionConfig | null> | null>(null);
  const [permissionLoadingKey, setPermissionLoadingKey] = useState<string | null>(null);
  const selectionKey = `${environmentId}\0${threadId || ''}`;
  const selectionKeyRef = useRef(selectionKey);
  selectionKeyRef.current = selectionKey;
  const connectorStatus = connectorState?.key === environmentId ? connectorState.value : null;
  const connectorStatusPending = online && connectorState?.key !== environmentId;
  const modelConfig = online && modelState?.key === selectionKey ? modelState.value : null;
  const modelConfigLoading = Boolean(
    online && threadId && (modelState?.key !== selectionKey || modelLoadingKey === selectionKey),
  );
  const permissionConfig = online && connectorStatus && permissionState?.key === selectionKey
    ? permissionState.value : null;
  const permissionConfigLoading = Boolean(
    connectorStatusPending || (connectorStatus
      && (permissionState?.key !== selectionKey || permissionLoadingKey === selectionKey)),
  );

  useEffect(() => {
    if (!online) {
      setConnectorState(null);
      return undefined;
    }
    let disposed = false;
    void request<ConnectorStatus>('connector.status', {})
      .then((status) => {
        if (!disposed) setConnectorState({ key: environmentId, value: status });
      })
      .catch(() => {
        if (!disposed) setConnectorState({ key: environmentId, value: null });
      });
    return () => { disposed = true; };
  }, [environmentId, online, request]);

  useEffect(() => {
    if (!online || !connectorStatus) {
      return undefined;
    }
    if (!threadId) {
      setPermissionState({
        key: selectionKey,
        value: {
          mode: normalizePermissionMode(loadEnvironmentValue(SESSION_PERMISSION_MODE_KEY, environmentId)),
          editable: true,
          networkAccess: connectorStatus.capabilities.networkAccess,
          allowFullAccess: connectorStatus.capabilities.fullAccess,
        },
      });
      setPermissionLoadingKey(null);
      return undefined;
    }
    let disposed = false;
    const targetKey = selectionKey;
    setPermissionLoadingKey(targetKey);
    void request<SessionPermissionConfig>('session.permissions.read', { threadId })
      .then((config) => {
        if (!disposed && selectionKeyRef.current === targetKey) {
          setPermissionState({ key: targetKey, value: config });
        }
      })
      .catch(() => {
        if (!disposed && selectionKeyRef.current === targetKey) {
          setPermissionState({ key: targetKey, value: null });
        }
      })
      .finally(() => {
        if (!disposed && selectionKeyRef.current === targetKey) setPermissionLoadingKey(null);
      });
    return () => { disposed = true; };
  }, [connectorStatus, environmentId, online, request, selectionKey, threadId]);

  const savePermissionMode = useCallback(async (mode: PermissionMode) => {
    const targetKey = selectionKeyRef.current;
    const targetThreadId = threadId;
    let nextConfig: SessionPermissionConfig;
    if (targetThreadId) {
      nextConfig = await request<SessionPermissionConfig>('session.permissions.update', {
        threadId: targetThreadId, mode,
      });
    } else {
      if (!connectorStatus) throw new Error(t('执行环境尚未就绪', 'Execution environment is not ready'));
      if (mode === 'full' && !connectorStatus.capabilities.fullAccess) {
        throw new Error(t('此执行节点未开放完全访问', 'Full access is not enabled on this connector'));
      }
      nextConfig = {
        mode,
        editable: true,
        networkAccess: connectorStatus.capabilities.networkAccess,
        allowFullAccess: connectorStatus.capabilities.fullAccess,
      };
    }
    storeEnvironmentValue(SESSION_PERMISSION_MODE_KEY, environmentId, mode);
    if (selectionKeyRef.current === targetKey) {
      setPermissionState({ key: targetKey, value: nextConfig });
    }
  }, [connectorStatus, environmentId, request, threadId]);

  useEffect(() => {
    if (!threadId || !online) {
      setModelLoadingKey(null);
      return undefined;
    }
    let disposed = false;
    const targetKey = selectionKey;
    setModelLoadingKey(targetKey);
    void request<SessionModelConfig>('session.model-config.read', { threadId })
      .then((config) => {
        if (!disposed && selectionKeyRef.current === targetKey) {
          setModelState({ key: targetKey, value: config });
        }
      })
      .catch(() => {
        if (!disposed && selectionKeyRef.current === targetKey) {
          setModelState({ key: targetKey, value: null });
        }
      })
      .finally(() => {
        if (!disposed && selectionKeyRef.current === targetKey) setModelLoadingKey(null);
      });
    return () => { disposed = true; };
  }, [online, request, selectionKey, threadId]);

  const saveModelConfig = useCallback(async (draft: ModelConfigDraft) => {
    const targetKey = selectionKeyRef.current;
    if (!threadId) throw new Error('thread_id_required');
    const config = await request<SessionModelConfig>('session.model-config.update', {
      threadId,
      ...draft,
    });
    if (selectionKeyRef.current === targetKey) {
      setModelState({ key: targetKey, value: config });
    }
  }, [request, threadId]);

  return {
    connectorStatus,
    modelConfig,
    modelConfigLoading,
    permissionConfig,
    permissionConfigLoading,
    saveModelConfig,
    savePermissionMode,
  };
}
