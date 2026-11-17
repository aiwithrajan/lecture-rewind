import '@smartspectra/node-sdk/preload';
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc-channels';
import { ConsentRecord, SessionDocument, ChapterInfo, NetworkGuardStats } from '@shared/types';

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
  }
};

contextBridge.exposeInMainWorld('rewindApi', rewindApi);

export type RewindApi = typeof rewindApi;
