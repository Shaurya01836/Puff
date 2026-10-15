import type { PuffApi } from '@puff/shared';
import { createMockApi } from '@puff/shared/mocks';

/**
 * The PuffApi implementation the main process serves over IPC.
 * Phase P0: every method is backed by mocks so the UI can be built now.
 * From P1 on, methods move one by one to @puff/core (graph, indexer, orchestrator).
 */
export function createBackend(): PuffApi {
  return createMockApi();
}
