import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc-channels';
import {
  AgentRequest,
  AgentResponse,
  AgentStatus,
  ChapterInfo,
  ConsentRecord,
  NetworkGuardStats,
  SessionDocument
} from '@shared/types';

export const rewindApi = {
  sessions: {
    list: (): Promise<SessionDocument[]> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
    get: (id: string): Promise<SessionDocument | null> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, id),
    save: (doc: SessionDocument): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SAVE, doc),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, id),
    deleteAllData: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.DATA_DELETE_ALL)
  },
  consent: {
    get: (): Promise<ConsentRecord> => ipcRenderer.invoke(IPC_CHANNELS.CONSENT_GET),
    set: (consent: ConsentRecord): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONSENT_SET, consent)
  },
  network: {
    getStats: (): Promise<NetworkGuardStats> => ipcRenderer.invoke(IPC_CHANNELS.NETWORK_GET_STATS)
  },
  chapters: {
    parse: (filePath: string): Promise<ChapterInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.CHAPTERS_PARSE, filePath)
  },
  dialog: {
    openVideoFile: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FILE)
  },
  agent: {
    getStatus: (): Promise<AgentStatus> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STATUS),
    query: (req: AgentRequest): Promise<AgentResponse> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_QUERY, req)
  }
};

// Always expose rewindApi FIRST so sandboxed preload never blocks IPC bridge
contextBridge.exposeInMainWorld('rewindApi', rewindApi);

// Optionally load Presage SmartSpectra preload bridge when native runtime is available
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('@smartspectra/node-sdk/preload');
} catch {
  // Sandboxed preload or host architecture without native SmartSpectra C-FFI
}

export type RewindApi = typeof rewindApi;
