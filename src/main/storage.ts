import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ConsentRecord, SessionDocument } from '@shared/types';

export class StorageManager {
  private baseDir: string;
  private sessionsDir: string;
  private consentFile: string;

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      this.baseDir = customBaseDir;
    } else {
      try {
        this.baseDir = path.join(app.getPath('userData'), 'lecture-rewind-data');
      } catch {
        // Fallback for non-packaged/test environments
        this.baseDir = path.join(process.cwd(), '.test-user-data');
      }
    }

    this.sessionsDir = path.join(this.baseDir, 'sessions');
    this.consentFile = path.join(this.baseDir, 'consent.json');
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  public async saveSession(session: SessionDocument): Promise<void> {
    this.ensureDirectories();
    const filePath = path.join(this.sessionsDir, `${session.id}.json`);
    const data = JSON.stringify(session, null, 2);
    await fs.promises.writeFile(filePath, data, 'utf-8');
  }

  public async getSession(id: string): Promise<SessionDocument | null> {
    const filePath = path.join(this.sessionsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content) as SessionDocument;
  }

  public async listSessions(): Promise<SessionDocument[]> {
    this.ensureDirectories();
    const files = await fs.promises.readdir(this.sessionsDir);
    const sessions: SessionDocument[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf-8');
          sessions.push(JSON.parse(content));
        } catch {
          // Skip corrupted entries
        }
      }
    }

    // Sort by startedAt descending (most recent first)
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return sessions;
  }

  public async deleteSession(id: string): Promise<boolean> {
    const filePath = path.join(this.sessionsDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
      return true;
    }
    return false;
  }

  public async getConsent(): Promise<ConsentRecord> {
    if (fs.existsSync(this.consentFile)) {
      try {
        const content = await fs.promises.readFile(this.consentFile, 'utf-8');
        return JSON.parse(content) as ConsentRecord;
      } catch {
        // Fallback default
      }
    }
    return {
      granted: false,
      timestamp: '',
      telemetryEnabled: false
    };
  }

  public async setConsent(consent: ConsentRecord): Promise<void> {
    this.ensureDirectories();
    await fs.promises.writeFile(this.consentFile, JSON.stringify(consent, null, 2), 'utf-8');
  }

  /**
   * One-click complete irreversible data wipe (FR-16, Acceptance Criterion 7).
   * Deletes all session files, consent records, and calibration caches.
   */
  public async deleteAllData(): Promise<void> {
    if (fs.existsSync(this.sessionsDir)) {
      const files = await fs.promises.readdir(this.sessionsDir);
      for (const file of files) {
        await fs.promises.unlink(path.join(this.sessionsDir, file));
      }
    }

    if (fs.existsSync(this.consentFile)) {
      await fs.promises.unlink(this.consentFile);
    }

    // Remove the base directory if empty or delete recursively
    if (fs.existsSync(this.baseDir)) {
      await fs.promises.rm(this.baseDir, { recursive: true, force: true });
    }

    this.ensureDirectories();
  }
}
