import { useEffect, useRef, useState } from 'react';
import type { MascotStatus } from '../components/shared/mascot/Mascot';
import { useAppStore, type AppState } from '../store/useAppStore';

const RESULT_HOLD_MS = 1800;

interface MascotActivitySnapshot {
  visible: boolean;
  busyKeys: string;
  successKeys: string;
  errorKeys: string;
}

const EMPTY_ACTIVITY: MascotActivitySnapshot = {
  visible: false,
  busyKeys: '',
  successKeys: '',
  errorKeys: '',
};

function selectMascotActivity(state: AppState): MascotActivitySnapshot {
  if (!state.config.mascotVisible) return EMPTY_ACTIVITY;

  const busy: string[] = [];
  const success: string[] = [];
  const error: string[] = [];

  for (const node of state.nodes) {
    const status = (node.data as { status?: string })?.status;
    const key = `node:${node.id}`;
    if (status === 'loading') busy.push(key);
    else if (status === 'success') success.push(key);
    else if (status === 'error') error.push(key);
  }

  const currentProjectId = state.currentProjectId;
  for (const task of state.agentTasks) {
    if (task.projectId !== currentProjectId) continue;
    const key = `task:${task.id}`;
    if (['queued', 'planning', 'running', 'waiting_tool'].includes(task.status)) {
      busy.push(key);
    } else if (task.status === 'completed') {
      success.push(key);
    } else if (task.status === 'failed') {
      error.push(key);
    }
  }

  const projectConversationIds = new Set(
    state.conversations
      .filter((conversation) => conversation.projectId === currentProjectId && !conversation.deletedAt)
      .map((conversation) => conversation.id),
  );
  for (const message of state.messages) {
    if (!projectConversationIds.has(message.conversationId) || message.role !== 'assistant') continue;
    const key = `message:${message.id}`;
    const isBusy = ['queued', 'parsing', 'streaming', 'executing'].includes(message.status)
      || message.mediaStatus === 'queued'
      || message.mediaStatus === 'generating'
      || message.canvasStatus === 'pending';
    if (isBusy) {
      busy.push(key);
    } else if (
      message.status === 'error'
      || message.mediaStatus === 'failed'
      || message.canvasStatus === 'failed'
    ) {
      error.push(key);
    } else if (
      message.status === 'done'
      || message.mediaStatus === 'succeeded'
      || message.canvasStatus === 'created'
    ) {
      success.push(key);
    }
  }

  return {
    visible: true,
    busyKeys: busy.sort().join('|'),
    successKeys: success.sort().join('|'),
    errorKeys: error.sort().join('|'),
  };
}

function hasTrackedKey(tracked: Set<string>, encodedKeys: string): boolean {
  if (!encodedKeys) return false;
  return encodedKeys.split('|').some((key) => tracked.has(key));
}

export function useMascotStatus(): MascotStatus {
  const [initialActivity] = useState(() => selectMascotActivity(useAppStore.getState()));
  const [status, setStatus] = useState<MascotStatus>(
    initialActivity.visible && initialActivity.busyKeys ? 'thinking' : 'idle',
  );
  const trackedBusyKeys = useRef(new Set(
    initialActivity.busyKeys ? initialActivity.busyKeys.split('|') : [],
  ));
  const resultTimer = useRef<number | null>(null);

  useEffect(() => {
    let previousActivity = initialActivity;

    const clearResultTimer = () => {
      if (resultTimer.current !== null) window.clearTimeout(resultTimer.current);
      resultTimer.current = null;
    };

    const applyActivity = (activity: MascotActivitySnapshot) => {
      if (
        activity.visible === previousActivity.visible
        && activity.busyKeys === previousActivity.busyKeys
        && activity.successKeys === previousActivity.successKeys
        && activity.errorKeys === previousActivity.errorKeys
      ) return;
      previousActivity = activity;

      if (!activity.visible) {
        clearResultTimer();
        trackedBusyKeys.current.clear();
        setStatus('idle');
        return;
      }

      if (activity.busyKeys) {
        clearResultTimer();
        for (const key of activity.busyKeys.split('|')) trackedBusyKeys.current.add(key);
        setStatus('thinking');
        return;
      }

      if (trackedBusyKeys.current.size === 0) return;

      const completedWithError = hasTrackedKey(trackedBusyKeys.current, activity.errorKeys);
      const completedSuccessfully = hasTrackedKey(trackedBusyKeys.current, activity.successKeys);
      trackedBusyKeys.current.clear();
      clearResultTimer();

      if (!completedWithError && !completedSuccessfully) {
        setStatus('idle');
        return;
      }

      setStatus(completedWithError ? 'error' : 'success');
      resultTimer.current = window.setTimeout(() => {
        setStatus('idle');
        resultTimer.current = null;
      }, RESULT_HOLD_MS);
    };

    const unsubscribe = useAppStore.subscribe((state) => {
      applyActivity(selectMascotActivity(state));
    });

    return () => {
      unsubscribe();
      clearResultTimer();
    };
  }, [initialActivity]);

  return status;
}
