import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { TurnProgress } from '../../src/shared/turn-progress';
import type { ExecutionState, LiveActivityKind } from './app-types';

export type ConversationExecution = {
  running: boolean;
  ownedTurnThreadId: string | null;
  state: ExecutionState;
  purpose: string;
  detail: string;
  activity: LiveActivityKind;
  startedAt: number | null;
  progress: TurnProgress;
};

export type ConversationExecutionPatch = Partial<ConversationExecution>;

export function initialConversationExecution(
  state: ExecutionState = 'idle',
): ConversationExecution {
  return {
    running: false,
    ownedTurnThreadId: null,
    state,
    purpose: '',
    detail: '',
    activity: 'working',
    startedAt: null,
    progress: {},
  };
}

export function patchConversationExecution(
  current: ConversationExecution,
  patch: ConversationExecutionPatch,
): ConversationExecution {
  return { ...current, ...patch };
}

export function resetConversationExecutionPresentation(
  current: ConversationExecution,
  state: ExecutionState = 'idle',
) {
  return {
    ...initialConversationExecution(state),
    running: current.running,
    ownedTurnThreadId: current.ownedTurnThreadId,
  };
}

type FieldSetters = {
  [Key in keyof ConversationExecution as `set${Capitalize<Key>}`]: Dispatch<SetStateAction<ConversationExecution[Key]>>;
};

function fieldSetter<Key extends keyof ConversationExecution>(
  setExecution: Dispatch<SetStateAction<ConversationExecution>>,
  key: Key,
): Dispatch<SetStateAction<ConversationExecution[Key]>> {
  return (value) => setExecution((current) => patchConversationExecution(current, {
    [key]: typeof value === 'function'
      ? (value as (previous: ConversationExecution[Key]) => ConversationExecution[Key])(current[key])
      : value,
  }));
}

/**
 * Keeps the fields that describe one execution in a single state transition.
 * Field setters are retained for small live updates, while reset/patch allow
 * lifecycle boundaries to update atomically.
 */
export function useConversationExecution() {
  const [execution, setExecution] = useState(initialConversationExecution);
  const setters = useMemo(() => ({
    setRunning: fieldSetter(setExecution, 'running'),
    setOwnedTurnThreadId: fieldSetter(setExecution, 'ownedTurnThreadId'),
    setState: fieldSetter(setExecution, 'state'),
    setPurpose: fieldSetter(setExecution, 'purpose'),
    setDetail: fieldSetter(setExecution, 'detail'),
    setActivity: fieldSetter(setExecution, 'activity'),
    setStartedAt: fieldSetter(setExecution, 'startedAt'),
    setProgress: fieldSetter(setExecution, 'progress'),
  } satisfies FieldSetters), []);
  const updateExecution = useCallback((
    patch: ConversationExecutionPatch
      | ((current: ConversationExecution) => ConversationExecutionPatch),
  ) => {
    setExecution((current) => patchConversationExecution(
      current,
      typeof patch === 'function' ? patch(current) : patch,
    ));
  }, []);
  const resetExecution = useCallback((state: ExecutionState = 'idle') => {
    setExecution(initialConversationExecution(state));
  }, []);
  const resetExecutionPresentation = useCallback((state: ExecutionState = 'idle') => {
    setExecution((current) => resetConversationExecutionPresentation(current, state));
  }, []);

  return {
    execution,
    updateExecution,
    resetExecution,
    resetExecutionPresentation,
    ...setters,
  };
}
