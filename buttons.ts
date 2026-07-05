import { InlineKeyboardButton } from 'telegraf/types';

type IKB = InlineKeyboardButton[];

function row(...buttons: InlineKeyboardButton[]): IKB { return buttons; }
function btn(text: string, data: string): InlineKeyboardButton { return { text, callback_data: data }; }

// ── Universal navigation row ───────────────────────────────────────────────────
export const backBtn  = btn('⬅️ Back', 'back');
export const homeBtn  = btn('🏠 Home', 'home');
export const closeBtn = btn('❌ Close', 'close_menu');
const navRow   = row(backBtn, homeBtn, closeBtn);
const navShort = row(homeBtn, closeBtn);

// ── Main Menu ─────────────────────────────────────────────────────────────────
export function mainMenuKeyboard(isAdmin = false) {
  const rows: IKB[] = [
    row(btn('📈 Trading', 'trading'), btn('🤖 Signals', 'signals')),
    row(btn('⚙️ Settings', 'settings'), btn('👤 Profile', 'account')),
    row(btn('ℹ️ Help', 'help')),
  ];
  if (isAdmin) rows.splice(2, 0, row(btn('👑 Admin Panel', 'admin_home')));
  return { inline_keyboard: rows };
}

// ── Trading submenu ────────────────────────────────────────────────────────────
export function tradingMenuKeyboard() {
  return {
    inline_keyboard: [
      row(btn('📊 Live Dashboard', 'dashboard'), btn('📈 Open Trades', 'open_trades')),
      row(btn('📋 Trade History', 'history'),   btn('🔍 Market Scan', 'scan')),
      row(btn('🔎 Analyse Pair', 'analyse'),     btn('🤖 Auto Trading', 'autotrade_menu')),
      navShort,
    ],
  };
}

// ── Profile menu ──────────────────────────────────────────────────────────────
export function profileMenuKeyboard(hasKeys: boolean) {
  return {
    inline_keyboard: [
      hasKeys
        ? row(btn('📊 Dashboard', 'dashboard'), btn('🔌 Disconnect', 'disconnect_confirm'))
        : row(btn('🔗 Connect Exchange', 'connect')),
      navShort,
    ],
  };
}

// ── Connection type selection ─────────────────────────────────────────────────
export function connectionTypeKeyboard() {
  return {
    inline_keyboard: [
      row(btn('🧪 Testnet (testnet.binancefutures.com)', 'connect_testnet')),
      row(btn('💰 Real Account (fapi.binance.com)', 'connect_real')),
      navShort,
    ],
  };
}

export function connectionActionsKeyboard() {
  return {
    inline_keyboard: [
      row(btn('🔗 Reconnect', 'connect'), btn('🔌 Disconnect', 'disconnect_confirm')),
      navShort,
    ],
  };
}

export function disconnectConfirmKeyboard() {
  return {
    inline_keyboard: [
      row(btn('✅ Yes, Disconnect', 'disconnect_yes'), btn('❌ Cancel', 'home')),
    ],
  };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export function dashboardKeyboard() {
  return {
    inline_keyboard: [
      row(btn('🔄 Refresh', 'dashboard_refresh'), btn('📈 Positions', 'open_trades')),
      row(btn('📋 History', 'history'),            btn('🤖 Auto Trade', 'autotrade_menu')),
      navShort,
    ],
  };
}

// ── Open Trades ───────────────────────────────────────────────────────────────
export function openTradesKeyboard(firstTradeId?: number) {
  const rows: IKB[] = [
    row(btn('🔄 Refresh', 'trades_refresh'), btn('❌ Close ALL', 'close_all_confirm')),
  ];
  if (firstTradeId) rows.splice(1, 0, row(btn(`💼 Manage Trade #${firstTradeId}`, `manage_${firstTradeId}`)));
  rows.push(navShort);
  return { inline_keyboard: rows };
}

// ── Trade Management ──────────────────────────────────────────────────────────
export function tradeManagementKeyboard(tradeId: number) {
  return {
    inline_keyboard: [
      row(btn('🔄 Refresh', `manage_${tradeId}`),     btn('❌ Close Position', `close_pos_${tradeId}`)),
      row(btn('25%', `close25_${tradeId}`),            btn('50%', `close50_${tradeId}`), btn('75%', `close75_${tradeId}`)),
      row(btn('🛡 Break Even', `be_${tradeId}`),       btn('🔁 Reverse', `reverse_${tradeId}`)),
      row(btn('📉 Move SL', `move_sl_${tradeId}`),     btn('📈 Move TP', `move_tp_${tradeId}`)),
      row(btn('🚫 Cancel SL', `cancel_sl_${tradeId}`), btn('🚫 Cancel TP', `cancel_tp_${tradeId}`)),
      row(homeBtn, btn('⬅️ Trades', 'open_trades'), closeBtn),
    ],
  };
}

export function closeAllConfirmKeyboard() {
  return {
    inline_keyboard: [
      row(btn('✅ Close ALL Positions', 'close_all_yes'), btn('❌ Cancel', 'open_trades')),
    ],
  };
}

// ── Auto Trading ──────────────────────────────────────────────────────────────
export function autoTradeKeyboard(isOn: boolean) {
  return {
    inline_keyboard: [
      row(btn(isOn ? '🔴 Turn OFF Auto Trading' : '🟢 Turn ON Auto Trading', 'autotrade_toggle')),
      navShort,
    ],
  };
}

// ── Signals ───────────────────────────────────────────────────────────────────
export function signalsKeyboard() {
  return {
    inline_keyboard: [
      row(btn('🔄 Refresh', 'signals_refresh'), btn('🔍 Scan Now', 'scan')),
      navShort,
    ],
  };
}

// ── Market Scan ───────────────────────────────────────────────────────────────
export function scanKeyboard() {
  return {
    inline_keyboard: [
      row(btn('🔄 Scan Again', 'scan'), btn('📡 Signals', 'signals')),
      navShort,
    ],
  };
}

// ── History ───────────────────────────────────────────────────────────────────
export function historyKeyboard() {
  return {
    inline_keyboard: [
      row(btn('🔄 Refresh', 'history'), btn('📊 Dashboard', 'dashboard')),
      navShort,
    ],
  };
}

// ── Account / Profile ─────────────────────────────────────────────────────────
export function accountKeyboard(hasKeys: boolean) {
  return profileMenuKeyboard(hasKeys);
}

// ── Settings ─────────────────────────────────────────────────────────────────
export function settingsKeyboard() {
  return {
    inline_keyboard: [
      row(btn('⚡ Leverage', 'set_leverage'),     btn('📊 Risk %', 'set_risk')),
      row(btn('🎯 Confidence %', 'set_confidence'), btn('🔢 Max Trades', 'set_max_trades')),
      row(btn('🛡 Break Even', 'toggle_be'),       btn('📉 Trailing Stop', 'toggle_ts')),
      navShort,
    ],
  };
}

// ── Admin Panel ───────────────────────────────────────────────────────────────
export function adminMainKeyboard() {
  return {
    inline_keyboard: [
      row(btn('📊 Dashboard',   'admin_dashboard'),  btn('👥 Users',     'admin_users')),
      row(btn('📈 Statistics',  'admin_stats'),       btn('📡 Signals',   'admin_signals')),
      row(btn('💹 Trading',     'admin_trading'),     btn('🔑 API Keys',  'admin_apikeys')),
      row(btn('📜 Logs',        'admin_logs'),        btn('🗄 Database',  'admin_db')),
      row(btn('⚙️ Settings',    'admin_settings'),    btn('📢 Broadcast', 'admin_broadcast')),
      row(btn('🔧 Maintenance', 'admin_maintenance'), btn('🔁 Restart',   'admin_restart')),
      row(btn('💾 Backup DB',   'admin_backup'),      btn('📥 Restore DB','admin_restore')),
      row(homeBtn, closeBtn),
    ],
  };
}

export function adminNavRow() {
  return row(btn('⬅️ Admin', 'admin_home'), homeBtn, closeBtn);
}

export function adminUsersKeyboard(users: Array<{ telegram_id: string; username?: string; first_name?: string }>) {
  const userBtns = users.slice(0, 10).map(u =>
    row(btn(`👤 ${u.username ? '@' + u.username : u.first_name || u.telegram_id}`, `admin_user_${u.telegram_id}`))
  );
  return {
    inline_keyboard: [
      ...userBtns,
      [btn('⬅️ Admin', 'admin_home'), homeBtn, closeBtn],
    ],
  };
}

export function adminUserDetailKeyboard(telegramId: string, isActive: boolean, autoTrade: boolean) {
  return {
    inline_keyboard: [
      row(
        btn(isActive ? '🚫 Ban User' : '✅ Unban User', `admin_ban_${telegramId}`),
        btn(autoTrade ? '⏸ Disable Auto' : '▶️ Enable Auto', `admin_autotrade_${telegramId}`)
      ),
      row(btn('🔌 Force Disconnect API', `admin_disconnect_${telegramId}`)),
      [btn('⬅️ Users', 'admin_users'), homeBtn, closeBtn],
    ],
  };
}

export function adminBroadcastKeyboard() {
  return {
    inline_keyboard: [
      row(btn('📢 Send Broadcast', 'admin_broadcast_send')),
      [btn('⬅️ Admin', 'admin_home'), homeBtn, closeBtn],
    ],
  };
}

export function adminMaintenanceKeyboard(maintenanceMode: boolean) {
  return {
    inline_keyboard: [
      row(btn(maintenanceMode ? '✅ Disable Maintenance' : '🔧 Enable Maintenance', 'admin_toggle_maintenance')),
      row(btn('🔁 Restart Bot', 'admin_restart')),
      [btn('⬅️ Admin', 'admin_home'), homeBtn, closeBtn],
    ],
  };
}
