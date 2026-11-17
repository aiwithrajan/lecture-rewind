import { Session } from 'electron';
import { NetworkGuardStats } from '@shared/types';

export class NetworkGuard {
  private blockedCount: number = 0;
  private allowedCount: number = 0;
  private appRequestCount: number = 0;
  private requestLog: NetworkGuardStats['log'] = [];
  private allowPresageLicensing: boolean = true;

  public setAllowPresageLicensing(allow: boolean): void {
    this.allowPresageLicensing = allow;
  }

  public attach(session: Session): void {
    session.webRequest.onBeforeRequest((details, callback) => {
      const evaluation = this.evaluateUrl(details.url);

      if (evaluation.cancel) {
        this.blockedCount++;
        this.appRequestCount++;
        this.logRequest(details.url, 'blocked', evaluation.reason);
        callback({ cancel: true });
      } else {
        this.allowedCount++;
        this.logRequest(details.url, 'allowed', evaluation.reason);
        callback({ cancel: false });
      }
    });
  }

  public evaluateUrl(url: string): { cancel: boolean; reason: string } {
    // 1. Allow local dev server and internal schemas
    if (
      url.startsWith('http://localhost:') ||
      url.startsWith('http://127.0.0.1:') ||
      url.startsWith('ws://localhost:') ||
      url.startsWith('ws://127.0.0.1:')
    ) {
      return { cancel: false, reason: 'Localhost development server traffic' };
    }

    if (
      url.startsWith('file:') ||
      url.startsWith('local-video:') ||
      url.startsWith('blob:') ||
      url.startsWith('data:') ||
      url.startsWith('devtools:') ||
      url.startsWith('chrome:') ||
      url.startsWith('chrome-extension:')
    ) {
      return { cancel: false, reason: 'Internal Electron protocol' };
    }

    // 1b. Allow user-requested YouTube lecture embed playback streams
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (
        host === 'youtube.com' ||
        host.endsWith('.youtube.com') ||
        host === 'youtube-nocookie.com' ||
        host.endsWith('.youtube-nocookie.com') ||
        host === 'youtu.be' ||
        host.endsWith('.ytimg.com') ||
        host.endsWith('.googlevideo.com') ||
        host.endsWith('.ggpht.com') ||
        host === 'fonts.gstatic.com' ||
        host === 'www.gstatic.com'
      ) {
        return { cancel: false, reason: 'User-requested lecture video stream' };
      }
    } catch {
      // Malformed URL falls through to block
    }

    // 2. Allow Presage licensing/C-FFI endpoints if enabled
    if (this.allowPresageLicensing) {
      if (
        url.includes('presagetech.com') ||
        url.includes('smartspectra.presagetech.com') ||
        url.includes('physiology.presagetech.com')
      ) {
        return { cancel: false, reason: 'Presage license authorization' };
      }
    }

    // 3. Block all unexpected outbound application network requests (Acceptance Criterion 8)
    return {
      cancel: true,
      reason: 'Blocked by Local Privacy Firewall (Acceptance Criterion 8)'
    };
  }

  public getStats(): NetworkGuardStats {
    return {
      blockedRequestsCount: this.blockedCount,
      allowedRequestsCount: this.allowedCount,
      applicationNetworkRequestsCount: this.appRequestCount,
      log: [...this.requestLog]
    };
  }

  public resetStats(): void {
    this.blockedCount = 0;
    this.allowedCount = 0;
    this.appRequestCount = 0;
    this.requestLog = [];
  }

  private logRequest(url: string, action: 'allowed' | 'blocked', reason: string): void {
    this.requestLog.push({
      timestamp: new Date().toISOString(),
      url,
      action,
      reason
    });

    // Keep log bounded to last 100 entries
    if (this.requestLog.length > 100) {
      this.requestLog.shift();
    }
  }
}
