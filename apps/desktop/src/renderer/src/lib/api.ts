import type { PuffApi } from '@puff/shared';
import { createMockApi } from '@puff/shared/mocks';

declare global {
  interface Window {
    /** Exposed by the Electron preload script. Absent when the renderer runs in a plain browser. */
    puff?: PuffApi;
  }
}

/** True when running inside Electron with the real IPC bridge. */
export const inElectron = typeof window !== 'undefined' && window.puff !== undefined;

export const puff: PuffApi = window.puff ?? createMockApi();
