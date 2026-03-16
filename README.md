# UsageWatcher — Cursor Usage Statusline

A VS Code / Cursor IDE extension that displays a **Claude-Code style statusline** showing real-time Cursor usage metrics from Cursor usage APIs.

```
█████░░░░░ 50% | $24.50
```

## Features

- **Usage progress bar** — Visual 10-segment bar with percentage
- **Cost tracking** — Current total spend in USD
- **Color-coded warnings** — Yellow at 60%, red at 80% usage
- **Auto-refresh** — Polls the API at a configurable interval (default 60s)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Compile

```bash
npm run compile
```

### 3. Run in development mode

Press **F5** in VS Code / Cursor to launch the Extension Development Host.

### 4. Configure extension settings (optional)

Add these values to `settings.json` if you want to customize behavior:

```json
{
  "cursorStatusline.refreshInterval": 60,
  "cursorStatusline.monthlyBudget": 500
}
```

> **Note:** UsageWatcher reads your active Cursor login session. Make sure you're signed in to Cursor.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `cursorStatusline.refreshInterval` | `60` | Polling interval in seconds (min: 10) |
| `cursorStatusline.monthlyBudget` | `1000` | Monthly budget in USD for % calculation |

> **Usage % calculation:** When a request limit is available, the progress bar is based on `requests / limit`. If no limit is set, it falls back to `total cost / monthlyBudget`.

## Color Coding

| Usage | Color |
|---|---|
| 0–59% | Normal (default status bar color) |
| 60–79% | Yellow (warning) |
| 80–100% | Red (critical) |

## Error Handling

If the API is unreachable or session lookup fails, the status bar shows:

```
⚠ Cursor usage unavailable
```

The extension will retry automatically on the next polling interval.

## Project Structure

```
src/
  extension.ts    — Extension entry point, lifecycle management
  statusline.ts   — Status bar UI with multiple items
  api.ts          — Cursor usage API client + session detection
  config.ts       — Settings management
```