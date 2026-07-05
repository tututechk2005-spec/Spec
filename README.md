# Telegram AI Binance Futures Trading Bot v2.0

Professional edition with inline menus, live dashboard, AI signal engine, and full trade management.

## Setup

### 1. Environment Variables (Railway → Variables tab)
| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `ADMIN_CHAT_ID` | ✅ | Your Telegram user ID (from @userinfobot) |
| `ENCRYPTION_KEY` | Recommended | `openssl rand -hex 32` |
| `DB_PATH` | Optional | `/data/database.db` (add a Volume on Railway) |

### 2. Railway Volume (important for persistence)
- Go to your service → Volumes → Add Volume → Mount path: `/data`
- Set `DB_PATH=/data/database.db` in Variables

### 3. Deploy
Push to GitHub → Railway auto-detects `nixpacks.toml` → Runs `npm install && npm run build`

## Usage

Send `/start` to the bot. Everything is then controlled via inline buttons — no commands needed.

## Features
- Inline keyboard navigation (no commands after /start)
- Live dashboard auto-refreshing every 5 seconds
- AI signal engine: 4H + 1H + 15M confluence, 20+ indicators
- Session filter: London + New York only
- Min. 90% confidence threshold
- Partial close: 25% / 50% / 75%
- Break even, SL/TP management from Telegram
- All positions shown (manual + bot trades)
- AES-256 API key encryption
- Multi-user support
