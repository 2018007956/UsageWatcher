import * as vscode from 'vscode';

export interface UsageWatcherConfig {
  refreshInterval: number;
  monthlyBudget: number;
}

const SECTION = 'cursorStatusline';

export function getConfig(): UsageWatcherConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    refreshInterval: Math.max(10, cfg.get<number>('refreshInterval', 60)),
    monthlyBudget: cfg.get<number>('monthlyBudget', 1000),
  };
}

export function onConfigChange(cb: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      cb();
    }
  });
}
