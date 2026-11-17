import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { IPC_CHANNELS } from '@shared/ipc-channels';
import { ConsentRecord, SessionDocument } from '@shared/types';
import { StorageManager } from './storage';
import { NetworkGuard } from './network-guard';
import { parseChaptersForVideo } from './chapter-parser';
import { SessionReviewAgent } from './session-agent';

// Register custom local-video:// scheme with streaming & range support before app ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-video',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

let bindSmartSpectraIpc: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdkMain = require('@smartspectra/node-sdk/main');
  bindSmartSpectraIpc = sdkMain.bindSmartSpectraIpc;
} catch {
  console.warn(
    `[SmartSpectra] Native FFI library not available for host architecture (${process.platform}-${process.arch}). Operating in Simulated Mode (FR-17, AC-6).`
  );
}

let mainWindow: BrowserWindow | null = null;
const storageManager = new StorageManager();
const networkGuard = new NetworkGuard();
const sessionReviewAgent = new SessionReviewAgent();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Lecture Rewind',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  });

  // Attach SmartSpectra native SDK C-FFI MessagePort bridge if available (Section 3.1)
  if (typeof bindSmartSpectraIpc === 'function') {
    try {
      bindSmartSpectraIpc(win);
    } catch (err) {
      console.warn('[SmartSpectra] Failed to bind native IPC:', err);
    }
  }

  // Attach Local Privacy Firewall (Acceptance Criterion 8)
  networkGuard.attach(session.defaultSession);

  // Ensure YouTube embeds receive a valid Referer header in Electron (prevents Error 153)
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        'https://www.youtube.com/*',
        'https://www.youtube-nocookie.com/*',
        'https://*.googlevideo.com/*'
      ]
    },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      if (!headers['Referer'] || headers['Referer'].startsWith('http://localhost') || headers['Referer'].startsWith('file://')) {
        headers['Referer'] = 'https://www.youtube.com/';
      }
      callback({ requestHeaders: headers });
    }
  );

  // Load URL or static file
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

// Register IPC Channel Handlers
function registerIpcHandlers(): void {
  // Session Persistence
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    return storageManager.listSessions();
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, id: string) => {
    return storageManager.getSession(id);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_SAVE, async (_event, doc: SessionDocument) => {
    return storageManager.saveSession(doc);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, id: string) => {
    return storageManager.deleteSession(id);
  });

  ipcMain.handle(IPC_CHANNELS.DATA_DELETE_ALL, async () => {
    await storageManager.deleteAllData();
    networkGuard.resetStats();
    return true;
  });

  // Consent
  ipcMain.handle(IPC_CHANNELS.CONSENT_GET, async () => {
    return storageManager.getConsent();
  });

  ipcMain.handle(IPC_CHANNELS.CONSENT_SET, async (_event, consent: ConsentRecord) => {
    return storageManager.setConsent(consent);
  });

  // Network Guard Stats (Acceptance Criterion 8)
  ipcMain.handle(IPC_CHANNELS.NETWORK_GET_STATS, async () => {
    return networkGuard.getStats();
  });

  // Chapter Parsing (FR-8)
  ipcMain.handle(IPC_CHANNELS.CHAPTERS_PARSE, async (_event, filePath: string) => {
    return parseChaptersForVideo(filePath);
  });

  // File Picker Dialog
  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_FILE, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Lecture Video',
      properties: ['openFile'],
      filters: [
        { name: 'Video Files', extensions: ['mp4', 'mkv', 'webm', 'mov'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // Hybrid Session Review Agent (Gemini + Local Ollama Failover)
  ipcMain.handle(IPC_CHANNELS.AGENT_STATUS, async () => {
    return sessionReviewAgent.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_QUERY, async (_event, req) => {
    return sessionReviewAgent.query(req);
  });
}

app.whenReady().then(() => {
  // Stream local lecture video files with full Range/seek support
  protocol.handle('local-video', (request) => {
    try {
      const url = new URL(request.url);
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        return new Response('Missing video path', { status: 400 });
      }
      const fileUrl = pathToFileURL(filePath).toString();
      return net.fetch(fileUrl, { headers: request.headers });
    } catch {
      return new Response('Invalid video path', { status: 400 });
    }
  });

  registerIpcHandlers();
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

// Guarantee camera and resource release on application quit (Section 11.4)
app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('closed');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
