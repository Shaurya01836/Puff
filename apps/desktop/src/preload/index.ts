import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_EVENT_CHANNEL,
  PUFF_INVOKE_METHODS,
  ipcChannel,
  type PuffApi,
  type PuffEvent,
} from '@puff/shared';

// Build window.puff from the shared method list so the contract is defined in one place.
const invoke = Object.fromEntries(
  PUFF_INVOKE_METHODS.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(ipcChannel(method), ...args),
  ]),
);

const api = {
  ...invoke,
  onEvent(cb: (e: PuffEvent) => void) {
    const listener = (_event: IpcRendererEvent, e: PuffEvent) => cb(e);
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, listener);
    };
  },
} as PuffApi;

contextBridge.exposeInMainWorld('puff', api);
