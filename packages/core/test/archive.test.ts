import { describe, expect, it } from 'vitest';
import { createMockApi } from '@puff/shared/mocks';
import type { PuffEvent } from '@puff/shared';

describe('Task archiving and clearing', () => {
  it('archives a non-running task and emits task:update', async () => {
    const events: PuffEvent[] = [];
    const api = createMockApi();
    api.onEvent((e) => events.push(e));

    const created = await api.createTask('proj_sample', {
      title: 'Fix edge case in checkout',
      type: 'implement',
      complexity: 'low',
    });

    // Planned task can be archived
    const archived = await api.archiveTask(created.id, true);
    expect(archived.archived).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task:update',
        task: expect.objectContaining({ id: created.id, archived: true }),
      }),
    );

    // Restoring unsets archived
    const restored = await api.archiveTask(created.id, false);
    expect(restored.archived).toBeFalsy();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task:update',
        task: expect.objectContaining({ id: created.id, archived: undefined }),
      }),
    );
  });

  it('refuses to archive a running or verifying task', async () => {
    const api = createMockApi();
    const tasks = await api.listTasks('proj_sample');
    const runningTask = tasks.find((t) => t.status === 'running' || t.status === 'verifying');
    expect(runningTask).toBeDefined();
    if (runningTask) {
      await expect(api.archiveTask(runningTask.id, true)).rejects.toThrow(
        /not running can be archived/,
      );
    }
  });

  it('clearFinishedTasks archives done, failed, escalated and stopped tasks, leaving others untouched', async () => {
    const api = createMockApi();
    const before = await api.listTasks('proj_sample');

    const cleared = await api.clearFinishedTasks('proj_sample');
    expect(cleared.length).toBeGreaterThan(0);

    // Every cleared task has archived: true
    for (const t of cleared) {
      expect(t.archived).toBe(true);
      expect(
        ['done', 'failed', 'escalated'].includes(t.status) ||
          (t.trail ?? []).some((e) => e.outcome === 'stopped'),
      ).toBe(true);
      expect(['running', 'verifying'].includes(t.status)).toBe(false);
    }

    const after = await api.listTasks('proj_sample');
    const activeTasks = after.filter((t) => !t.archived);
    // Active tasks should not contain any done or failed tasks
    for (const t of activeTasks) {
      expect(t.status).not.toBe('done');
      expect(t.status).not.toBe('failed');
    }
  });
});
