/**
 * Type-safe IPC Channel Definitions
 * Connecting Main, Preload, and Renderer processes
 */

export const IPC_CHANNELS = {
  // Session Persistence (FR-12, FR-16)
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_SAVE: 'session:save',
  SESSION_DELETE: 'session:delete',
  DATA_DELETE_ALL: 'data:delete-all',

  // Consent Management (FR-3, FR-18)
  CONSENT_GET: 'consent:get',
  CONSENT_SET: 'consent:set',

  // Network Firewall Stats (Acceptance Criterion 8)
  NETWORK_GET_STATS: 'network:get-stats',

  // Chapter Parsing (FR-8)
  CHAPTERS_PARSE: 'chapters:parse',

  // Native Dialogs
  DIALOG_OPEN_FILE: 'dialog:open-file',

  // Hybrid Session Review Agent (Gemini + Local Ollama Failover)
  AGENT_STATUS: 'agent:status',
  AGENT_QUERY: 'agent:query'
} as const;

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
