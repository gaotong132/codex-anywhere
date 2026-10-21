import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { t } from './i18n';
import { loadEnvironmentValue, storeEnvironmentValue } from './execution-environments';
import { normalizePermissionMode, type PermissionMode } from '../../src/shared/permission-mode';
import type { BridgeRequest } from './bridge-request-manager';
import type {
  ConnectorStatus,
  NativeDesktopState,
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
  desktopState,
  recoveryKey = '',
}: {
  environmentId: string;
  online: boolean;
  threadId: string | null;
  request: BridgeRequest;
  desktopState?: NativeDesktopState | null;
  recoveryKey?: string;
}) {
  const [modelState, setModelState] = useState<KeyedValue<SessionModelConfig | null> | null>(null);
  const [modelLoadingKey, setModelLoadingKey] = useState<string | null>(null);
  const [modelReadAttempt, setModelReadAttempt] = useState(0);
  const refreshModelConfig = useCallback(() => setModelReadAttempt(value => value + 1), []);
  const [connectorState, setConnectorState] = useState<KeyedValue<ConnectorStatus | null> | null>(null);
  const [permissionState, setPermissionState] = useState<KeyedValue<SessionPermissionConfig | null> | null>(null);
  const [permissionLoadingKey, setPermissionLoadingKey] = useState<string | null>(null);
  const permissionRequestRef = useRef(0);
  const selectionKey = `${environmentId}\0${threadId || ''}`;
  const selectionKeyRef = useRef(selectionKey);
  selectionKeyRef.current = selectionKey;
  const connectorStatus = connectorState?.key === environmentId ? connectorState.value : null;
  const connectorStatusPending = online && connectorState?.key !== environmentId;
  const modelConfig = online && modelState?.key === selectionKey ? modelState.value : null;
  const modelConfigLoading = Boolean(
    online && threadId && !modelConfig && (modelState?.key !== selectionKey || modelLoadingKey === selectionKey),
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
  }, [environmentId, online, request, recoveryKey]);

  const refreshPermissionConfig = useCallback(async () => {
    const requestNumber = ++permissionRequestRef.current;
    if (!online || !connectorStatus) {
      return;
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
      return;
    }
    const targetKey = selectionKey;
    const isCurrent = () => permissionRequestRef.current === requestNumber && selectionKeyRef.current === targetKey;
    setPermissionLoadingKey(targetKey);
    try {
      const config = await request<SessionPermissionConfig>('session.permissions.read', { threadId });
      if (isCurrent()) setPermissionState({ key: targetKey, value: config });
    } catch (error) {
      if (isCurrent()) setPermissionState((previous) => previous?.key === targetKey ? previous : { key: targetKey, value: null });
      throw error;
    } finally {
      if (isCurrent()) setPermissionLoadingKey(null);
    }
  }, [connectorStatus, environmentId, online, request, selectionKey, threadId]);

  useEffect(() => {
    void refreshPermissionConfig().catch(() => {});
    return () => { permissionRequestRef.current += 1; };
  }, [refreshPermissionConfig]);

  const openPermissionSettingsOnDesktop = useCallback(async () => {
    if (!threadId) throw new Error('thread_id_required');
    await request('session.desktop.open', { threadId });
  }, [request, threadId]);

  const savePermissionMode = useCallback(async (mode: PermissionMode) => {
    permissionRequestRef.current += 1;
    setPermissionLoadingKey(null);
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
    const abort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const targetKey = selectionKey;
    setModelLoadingKey(targetKey);
    const isCurrent = () => !disposed && selectionKeyRef.current === targetKey;
    const read = async (attempt: number) => {
      let retry = false;
      try {
        const config = await request<SessionModelConfig>('session.model-config.read', { threadId },
          { timeoutMs: 12_000, signal: abort.signal });
        if (!isCurrent()) return;
        setModelState({ key: targetKey, value: config });
        // A cold catalog can arrive after the lightweight current model.
        retry = !config.models.length && attempt === 0;
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : '';
        retry = attempt === 0 && /^(?:desktop_input_not_ready|desktop_input_unavailable|desktop_model_unavailable|desktop_state_\w+|request_timeout)$|timeout/i.test(message);
        setModelState(previous => previous?.key === targetKey ? previous : { key: targetKey, value: null });
      } finally {
        if (isCurrent()) {
          if (retry) retryTimer = setTimeout(() => { void read(1); }, 800);
          else setModelLoadingKey(null);
        }
      }
    };
    void read(0);
    return () => { disposed = true; clearTimeout(retryTimer); abort.abort(); };
  }, [online, request, selectionKey, threadId, modelReadAttempt, recoveryKey]);

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

  useEffect(() => {
    if (!desktopState?.model || desktopState.threadId !== threadId) return;
    setModelState(previous => {
      if (previous?.key !== selectionKey || !previous.value) return { key: selectionKey, value: {
        model: desktopState.model!, reasoningEffort: desktopState.reasoningEffort || '',
        serviceTier: desktopState.serviceTier || null, fastMode: /fast|priority/i.test(desktopState.serviceTier || ''),
        source: 'desktop', readOnly: true, models: [],
      } };
      const tier = desktopState.serviceTier || 'default';
      const option = previous.value.models.find(model => model.model === desktopState.model)?.serviceTiers.find(value => value.id === tier);
      if (!previous.value.readOnly && previous.value.model === desktopState.model && previous.value.reasoningEffort === desktopState.reasoningEffort
        && previous.value.serviceTier === tier) return previous;
      return { key: selectionKey, value: { ...previous.value, source: 'desktop', readOnly: !previous.value.models.length, model: desktopState.model!,
        reasoningEffort: desktopState.reasoningEffort || '', serviceTier: tier,
        fastMode: /fast|priority/i.test(`${tier} ${option?.name || ''}`) } };
    });
  }, [desktopState, selectionKey, threadId]);

  return {
    connectorStatus,
    modelConfig,
    modelConfigLoading,
    refreshModelConfig,
    permissionConfig,
    permissionConfigLoading,
    refreshPermissionConfig,
    openPermissionSettingsOnDesktop,
    saveModelConfig,
    savePermissionMode,
  };
}
