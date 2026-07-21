import { afterEach, describe, expect, it } from 'vitest';
import {
  closeAgentInterjectionBuffer,
  drainAgentInterjections,
  enqueueAgentInterjection,
  openAgentInterjectionBuffer,
  resetAgentInterjectionsForTests,
} from '../../../src/services/chat/agentInterjection';

afterEach(() => resetAgentInterjectionsForTests());

describe('agent interjection buffer', () => {
  it('accepts messages only while the task buffer is active', () => {
    expect(enqueueAgentInterjection('task-1', 'before open')).toBeNull();
    openAgentInterjectionBuffer('task-1');
    expect(enqueueAgentInterjection('task-1', 'adjust the current task')?.text)
      .toBe('adjust the current task');
    closeAgentInterjectionBuffer('task-1');
    expect(enqueueAgentInterjection('task-1', 'after close')).toBeNull();
  });

  it('drains messages in FIFO order without merging them', () => {
    openAgentInterjectionBuffer('task-1');
    enqueueAgentInterjection('task-1', 'first');
    enqueueAgentInterjection('task-1', 'second');

    expect(drainAgentInterjections('task-1').map((item) => item.text)).toEqual(['first', 'second']);
    expect(drainAgentInterjections('task-1')).toEqual([]);
  });
});
