import * as vscode from 'vscode';
import { UsageData } from './api';

const BAR_LENGTH = 10;
const FILLED = '🟩';
const EMPTY = '⬛';

export class Statusline implements vscode.Disposable {
  private usageItem: vscode.StatusBarItem;
  private costItem: vscode.StatusBarItem;
  private errorItem: vscode.StatusBarItem;

  constructor() {
    const p = vscode.StatusBarAlignment.Left;
    const base = 100;

    this.usageItem = vscode.window.createStatusBarItem(p, base + 4);
    this.costItem  = vscode.window.createStatusBarItem(p, base + 3);
    this.errorItem = vscode.window.createStatusBarItem(p, base + 6);

    this.errorItem.hide();
  }

  updateUsage(data: UsageData): void {
    this.errorItem.hide();

    // Progress bar
    const clamped = Math.max(0, Math.min(100, data.usagePercent));
    const filled = Math.round((clamped / 100) * BAR_LENGTH);
    const empty = BAR_LENGTH - filled;
    const pct = Math.round(data.usagePercent);
    const usageTooltip = [
      `Usage: ${pct}%`,
      data.totalRequestLimit > 0
        ? `Requests: ${data.totalRequests}/${data.totalRequestLimit}`
        : `Requests: ${data.totalRequests}`,
      `Included: $${data.includedUsage.toFixed(2)}`,
      `On-demand: $${data.onDemandUsage.toFixed(2)}`,
      data.periodStart
        ? `Since ${formatPeriod(data.periodStart)}`
        : '',
    ].filter(Boolean).join('\n');

    this.usageItem.text = `${FILLED.repeat(filled)}${EMPTY.repeat(empty)} ${pct}%`;
    this.usageItem.tooltip = usageTooltip;
    this.usageItem.backgroundColor = undefined;
    this.usageItem.show();

    // Cost
    this.costItem.text = `$${data.totalCost.toFixed(2)}`;
    this.costItem.tooltip = `Total spend this billing period: $${data.totalCost.toFixed(2)}`;
    this.costItem.show();
  }

  showError(message: string): void {
    this.usageItem.hide();
    this.costItem.hide();

    this.errorItem.text = `$(warning) ${message}`;
    this.errorItem.tooltip = message;
    this.errorItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.errorItem.show();
  }

  hideAll(): void {
    this.usageItem.hide();
    this.costItem.hide();
    this.errorItem.hide();
  }

  dispose(): void {
    this.usageItem.dispose();
    this.costItem.dispose();
    this.errorItem.dispose();
  }
}

function formatPeriod(v: string): string {
  if (!v) {
    return '';
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    return v;
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
