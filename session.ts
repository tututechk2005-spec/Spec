// ── Session Store ─────────────────────────────────────────────────────────────
// In-memory sessions for each user. Tracks navigation state, pending inputs,
// and dashboard refresh timers.

export type InputState =
  | 'idle'
  | 'await_api_key'
  | 'await_api_secret'
  | 'await_sl'
  | 'await_tp'
  | 'await_leverage'
  | 'await_risk'
  | 'await_confidence'
  | 'await_symbol_analyse';

export interface UserSession {
  currentMessageId: number | null;
  inputState: InputState;
  tempApiKey: string | null;
  tempTestnet: boolean;
  dashboardInterval: NodeJS.Timeout | null;
  editingTradeId: number | null;
  page: string;
}

const sessions = new Map<string, UserSession>();

function defaultSession(): UserSession {
  return {
    currentMessageId: null,
    inputState: 'idle',
    tempApiKey: null,
    tempTestnet: false,
    dashboardInterval: null,
    editingTradeId: null,
    page: 'home'
  };
}

export function getSession(telegramId: string): UserSession {
  if (!sessions.has(telegramId)) {
    sessions.set(telegramId, defaultSession());
  }
  return sessions.get(telegramId)!;
}

export function updateSession(telegramId: string, patch: Partial<UserSession>): void {
  const s = getSession(telegramId);
  Object.assign(s, patch);
}

export function clearDashboard(telegramId: string): void {
  const s = getSession(telegramId);
  if (s.dashboardInterval) {
    clearInterval(s.dashboardInterval);
    s.dashboardInterval = null;
  }
}

export function resetInput(telegramId: string): void {
  updateSession(telegramId, { inputState: 'idle', tempApiKey: null, editingTradeId: null });
}
