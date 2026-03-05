import * as vscode from 'vscode';
import { Statusline } from './statusline';
import { detectSession, fetchUsage } from './api';
import { getConfig, onConfigChange } from './config';

let statusline: Statusline;
let pollInterval: ReturnType<typeof setInterval> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  statusline = new Statusline();
  context.subscriptions.push(statusline);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorStatusline.refresh', () => {
      pollUsage();
    })
  );

  context.subscriptions.push(onConfigChange(() => {
    restartPolling();
  }));

  startPolling(context);
}

function startPolling(context: vscode.ExtensionContext): void {
  pollUsage();

  const config = getConfig();
  const intervalMs = config.refreshInterval * 1000;

  pollInterval = setInterval(() => pollUsage(), intervalMs);
  context.subscriptions.push(new vscode.Disposable(() => {
    if (pollInterval) { clearInterval(pollInterval); }
  }));
}

function restartPolling(): void {
  if (pollInterval) { clearInterval(pollInterval); }

  const config = getConfig();
  const intervalMs = config.refreshInterval * 1000;

  pollUsage();
  pollInterval = setInterval(() => pollUsage(), intervalMs);
}

async function pollUsage(): Promise<void> {
  const session = detectSession();
  if (!session) {
    statusline.showError('Cursor session not found — make sure Cursor is logged in');
    return;
  }

  const config = getConfig();

  try {
    const usageData = await fetchUsage(session, config.monthlyBudget);
    statusline.updateUsage(usageData);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    statusline.showError(`Cursor usage unavailable — ${msg}`);
    console.error('[UsageWatcher]', msg);
  }
}

export function deactivate(): void {
  if (pollInterval) { clearInterval(pollInterval); }
  statusline?.dispose();
}
