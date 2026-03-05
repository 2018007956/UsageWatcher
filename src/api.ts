import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { URL } from 'url';
import { execSync } from 'child_process';

export interface UsageItem {
  model: string;
  requestCount: number;
  tokenCount: number;
  cost: number;
}

export interface UsageData {
  totalCost: number;
  includedUsage: number;
  onDemandUsage: number;
  usagePercent: number;
  totalRequests: number;
  totalRequestLimit: number;
  models: UsageItem[];
  periodStart: string;
  periodEnd: string;
}

export interface SessionInfo {
  token: string;
  userId: string;
  cookieValue: string;
}

interface UsageEventsResponse {
  usageEventsDisplay?: Array<{
    timestamp?: string;
    model?: string;
    kind?: string;
    userEmail?: string;
    usageBasedCosts?: string | number;
    chargedCents?: number;
    isChargeable?: boolean;
    cursorTokenFee?: number;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheWriteTokens?: number;
      cacheReadTokens?: number;
      totalCents?: number;
    };
  }>;
  numPages?: number;
  pagination?: {
    numPages?: number;
    currentPage?: number;
    hasNextPage?: boolean;
  };
}

interface BasicUsageResponse {
  startOfMonth?: string;
  'gpt-4'?: { numRequests?: number; maxRequestUsage?: number | null };
  [key: string]: unknown;
}

// ── Session token detection ──

function getCursorDbPath(): string {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  } else if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function readTokenFromSqlite(): string | null {
  const dbPath = getCursorDbPath();
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  try {
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function extractUserId(token: string): string | null {
  try {
    let decoded: string;
    try { decoded = decodeURIComponent(token); } catch { decoded = token; }

    if (decoded.includes('::')) {
      return decoded.split('::')[0];
    }

    const parts = decoded.split('.');
    if (parts.length === 3) {
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) { base64 += '='; }
      const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
      if (payload.sub) {
        const match = payload.sub.match(/user_[A-Za-z0-9]+/);
        if (match) { return match[0]; }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function detectSession(): SessionInfo | null {
  const token = readTokenFromSqlite();
  if (!token) { return null; }

  const userId = extractUserId(token);
  if (!userId) { return null; }

  let cookieValue = token;
  if (!cookieValue.includes('::') && !cookieValue.includes('%3A%3A')) {
    cookieValue = `${userId}%3A%3A${cookieValue}`;
  } else if (cookieValue.includes('::')) {
    cookieValue = cookieValue.replace('::', '%3A%3A');
  }

  return { token, userId, cookieValue };
}

// ── HTTP helpers ──

const API_BASE = 'https://cursor.com/api';

function buildHeaders(cookieValue: string, authToken: string, method: string, bodyStr: string): Record<string, string> {
  const h: Record<string, string> = {
    'Cookie': `WorkosCursorSessionToken=${cookieValue}`,
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    // Cursor backend validates origin on POST dashboard APIs.
    'Origin': 'https://cursor.com',
    'Referer': 'https://cursor.com/dashboard',
  };
  if (method === 'POST' && bodyStr) {
    h['Content-Length'] = Buffer.byteLength(bodyStr).toString();
  }
  return h;
}

function rawRequest<T>(
  fullUrl: string,
  method: string,
  headers: Record<string, string>,
  bodyStr: string,
  maxRedirects: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    const parsed = new URL(fullUrl);
    const opts: https.RequestOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method,
      timeout: 15000,
      headers,
    };

    const req = https.request(opts, (res) => {
      const status = res.statusCode ?? 0;

      if ([301, 302, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, fullUrl).toString();
        console.log(`[UsageWatcher] redirect ${status} → ${nextUrl}`);
        resolve(rawRequest<T>(nextUrl, method, headers, bodyStr, maxRedirects - 1));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (status === 401 || status === 403) {
          reject(new Error(`HTTP ${status}: ${raw.slice(0, 200)}`));
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Invalid JSON from ${fullUrl}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (method === 'POST' && bodyStr) { req.write(bodyStr); }
    req.end();
  });
}

function apiRequest<T>(
  method: 'GET' | 'POST',
  endpoint: string,
  cookieValue: string,
  authToken: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const fullUrl = `${API_BASE}${endpoint}`;
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = buildHeaders(cookieValue, authToken, method, bodyStr);
  return rawRequest<T>(fullUrl, method, headers, bodyStr, 5);
}

// ── Public API ──

export async function fetchUsage(session: SessionInfo, monthlyBudget: number): Promise<UsageData> {
  const { userId, cookieValue, token } = session;

  const basic = await apiRequest<BasicUsageResponse>('GET', `/usage?user=${userId}`, cookieValue, token);
  const now = Date.now();
  const periodStartMs = getMonthlyCycleStartMs(now);
  const periodStart = new Date(periodStartMs).toISOString();
  const periodEnd = new Date(now).toISOString();

  let models = parseUsageModels(basic);
  let totalRequests = models.reduce((sum, m) => sum + m.requestCount, 0);
  const totalLimit = getTotalRequestLimit(basic);
  let includedUsage = 0;
  let onDemandUsage = 0;
  let totalCost = 0;

  // /usage는 비용 정보를 주지 않으므로 events API로 비용/요청 정보를 보강한다.
  try {
    const summary = await fetchUsageSummaryFromEvents(cookieValue, token, periodStart);
    if (summary.models.length > 0 && totalRequests === 0) {
      models = summary.models;
      totalRequests = summary.totalRequests;
    }
    includedUsage = summary.includedUsage;
    onDemandUsage = summary.onDemandUsage;
    totalCost = summary.totalCost;
  } catch (err) {
    console.warn('[UsageWatcher] events summary fallback failed:', err);
  }

  const usagePercent = totalLimit > 0
    ? Math.min(100, (totalRequests / totalLimit) * 100)
    : monthlyBudget > 0
      ? Math.min(100, (totalCost / monthlyBudget) * 100)
      : 0;

  console.log(
    `[UsageWatcher] requests=${totalRequests}, limit=${totalLimit}, percent=${usagePercent.toFixed(1)}`
  );

  const normalized = normalizeIncludedAndOnDemand(includedUsage, onDemandUsage);

  return {
    totalCost: normalized.totalCost,
    includedUsage: normalized.includedUsage,
    onDemandUsage: normalized.onDemandUsage,
    usagePercent,
    totalRequests,
    totalRequestLimit: totalLimit,
    models,
    periodStart,
    periodEnd,
  };
}

function normalizeIncludedAndOnDemand(included: number, onDemand: number): {
  includedUsage: number;
  onDemandUsage: number;
  totalCost: number;
} {
  let includedUsage = included;
  let onDemandUsage = onDemand;

  // 제품 기대 동작: included가 먼저 소진(최대 $20)된 뒤 on-demand가 증가.
  if (onDemandUsage > 0 && includedUsage < 20) {
    const needed = 20 - includedUsage;
    const shift = Math.min(needed, onDemandUsage);
    includedUsage += shift;
    onDemandUsage -= shift;
  }

  const totalCost = includedUsage + onDemandUsage;
  return { includedUsage, onDemandUsage, totalCost };
}

interface EventsSummary {
  models: UsageItem[];
  totalRequests: number;
  totalCost: number;
  includedUsage: number;
  onDemandUsage: number;
}

async function fetchUsageSummaryFromEvents(
  cookieValue: string,
  authToken: string,
  periodStart: string
): Promise<EventsSummary> {
  const now = Date.now();
  const startMs = periodStart ? new Date(periodStart).getTime() : getMonthlyCycleStartMs(now);
  const pageSize = 200;
  const items: NonNullable<UsageEventsResponse['usageEventsDisplay']> = [];
  let page = 1;

  while (true) {
    const data = await apiRequest<UsageEventsResponse>(
      'POST',
      '/dashboard/get-filtered-usage-events',
      cookieValue,
      authToken,
      {
        teamId: 0,
        startDate: startMs,
        endDate: now,
        page,
        pageSize,
      },
    );

    const chunk = data.usageEventsDisplay ?? [];
    items.push(...chunk);
    const totalPages = data.numPages ?? data.pagination?.numPages;
    const hasNextFromPagination =
      typeof data.pagination?.hasNextPage === 'boolean'
        ? data.pagination.hasNextPage
        : undefined;
    const hasNextByTotalPages =
      typeof totalPages === 'number'
        ? page < totalPages
        : undefined;
    const hasNextByChunkSize = chunk.length >= pageSize;
    const hasNextPage =
      hasNextFromPagination
      ?? hasNextByTotalPages
      ?? hasNextByChunkSize;
    if (!hasNextPage || chunk.length === 0) {
      break;
    }
    page += 1;
  }

  console.log(`[UsageWatcher] events fetched pages=${page}, items=${items.length}, start=${new Date(startMs).toISOString().slice(0, 10)}`);

  if (items.length === 0) {
    return {
      models: [],
      totalRequests: 0,
      totalCost: 0,
      includedUsage: 0,
      onDemandUsage: 0,
    };
  }

  const filteredItems = items.filter((evt) => {
    const ts = parseEventTimestampMs(evt.timestamp);
    return ts >= startMs && ts <= now;
  });

  const byModel = new Map<string, UsageItem>();
  let includedCents = 0;
  let onDemandCents = 0;

  for (const evt of filteredItems) {
    const model = evt.model ?? 'unknown';
    const tokens =
      (evt.tokenUsage?.inputTokens ?? 0) +
      (evt.tokenUsage?.outputTokens ?? 0) +
      (evt.tokenUsage?.cacheWriteTokens ?? 0) +
      (evt.tokenUsage?.cacheReadTokens ?? 0);
    const includedCostCents = parseIncludedCostCents(evt);
    const onDemandCostCents = parseOnDemandCostCents(evt);
    const kind = (evt.kind ?? '').toLowerCase();
    const isIncludedByKind = kind.includes('included');
    const isOnDemandByKind = kind.includes('on-demand') || kind.includes('usage-based');
    const isChargeable = evt.isChargeable;

    // 우선순위: isChargeable > kind
    if (isChargeable === true) {
      onDemandCents += onDemandCostCents;
    } else if (isChargeable === false) {
      includedCents += includedCostCents;
    } else if (isIncludedByKind) {
      includedCents += includedCostCents;
    } else if (isOnDemandByKind) {
      onDemandCents += onDemandCostCents;
    } else {
      // Unknown type defaults to on-demand side.
      onDemandCents += onDemandCostCents;
    }
    const modelCostCents = isChargeable === false || isIncludedByKind
      ? includedCostCents
      : onDemandCostCents;
    const current = byModel.get(model);
    if (current) {
      current.requestCount += 1;
      current.tokenCount += tokens;
      current.cost += modelCostCents / 100;
    } else {
      byModel.set(model, {
        model,
        requestCount: 1,
        tokenCount: tokens,
        cost: modelCostCents / 100,
      });
    }
  }

  const models = Array.from(byModel.values()).sort((a, b) => b.requestCount - a.requestCount);
  const totalRequests = models.reduce((s, m) => s + m.requestCount, 0);
  const totalCost = (includedCents + onDemandCents) / 100;
  const includedUsage = includedCents / 100;
  const onDemandUsage = onDemandCents / 100;
  console.log(
    `[UsageWatcher] events summary models=${models.length}, requests=${totalRequests}, totalCost=${totalCost.toFixed(2)}, windowStart=${new Date(startMs).toISOString()}`
  );
  return { models, totalRequests, totalCost, includedUsage, onDemandUsage };
}

function getMonthlyCycleStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonthStart = Date.UTC(y, m, 4, 0, 5, 0, 93);
  if (nowMs >= thisMonthStart) {
    return thisMonthStart;
  }
  return Date.UTC(y, m - 1, 4, 0, 5, 0, 93);
}

function parseEventTimestampMs(ts?: string): number {
  if (!ts) {
    return 0;
  }
  // Cursor payload is usually epoch milliseconds in string form.
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  const d = new Date(ts).getTime();
  return Number.isFinite(d) ? d : 0;
}

function parseOnDemandCostCents(evt: NonNullable<UsageEventsResponse['usageEventsDisplay']>[number]): number {
  // 대시보드와 가장 가까운 정산값: chargedCents
  if (typeof evt.chargedCents === 'number') {
    return Math.round(evt.chargedCents);
  }
  if (typeof evt.usageBasedCosts === 'number') {
    const usageBased = Math.round(evt.usageBasedCosts * 100);
    const fee = typeof evt.cursorTokenFee === 'number' ? Math.round(evt.cursorTokenFee) : 0;
    return usageBased + fee;
  }
  if (typeof evt.usageBasedCosts === 'string') {
    const cleaned = evt.usageBasedCosts.replace(/[$,\s]/g, '');
    const parsed = parseFloat(cleaned);
    if (Number.isFinite(parsed)) {
      const usageBased = Math.round(parsed * 100);
      const fee = typeof evt.cursorTokenFee === 'number' ? Math.round(evt.cursorTokenFee) : 0;
      return usageBased + fee;
    }
  }
  if (evt.tokenUsage?.totalCents !== undefined && typeof evt.tokenUsage.totalCents === 'number') {
    return Math.round(evt.tokenUsage.totalCents);
  }
  return 0;
}

function parseIncludedCostCents(evt: NonNullable<UsageEventsResponse['usageEventsDisplay']>[number]): number {
  if (evt.tokenUsage?.totalCents !== undefined && typeof evt.tokenUsage.totalCents === 'number') {
    return Math.round(evt.tokenUsage.totalCents);
  }
  if (typeof evt.usageBasedCosts === 'number') {
    return Math.round(evt.usageBasedCosts * 100);
  }
  if (typeof evt.usageBasedCosts === 'string') {
    const cleaned = evt.usageBasedCosts.replace(/[$,\s]/g, '');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }
  if (typeof evt.chargedCents === 'number') {
    return Math.round(evt.chargedCents);
  }
  return 0;
}

function derivePeriodEnd(periodStart: string): string {
  if (!periodStart) {
    return '';
  }
  const start = new Date(periodStart);
  if (Number.isNaN(start.getTime())) {
    return '';
  }
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setDate(end.getDate() - 1);
  return end.toISOString();
}

function parseUsageModels(data: BasicUsageResponse): UsageItem[] {
  const models: UsageItem[] = [];

  for (const [model, value] of Object.entries(data)) {
    if (model === 'startOfMonth') { continue; }
    if (!value || typeof value !== 'object') { continue; }

    const req = (value as { numRequests?: unknown }).numRequests;
    const reqTotal = (value as { numRequestsTotal?: unknown }).numRequestsTotal;
    const requestCount =
      typeof req === 'number'
        ? req
        : (typeof reqTotal === 'number' ? reqTotal : 0);
    if (requestCount <= 0) { continue; }

    const tokenCountRaw = (value as { numTokens?: unknown }).numTokens;
    const tokenCount = typeof tokenCountRaw === 'number' ? tokenCountRaw : 0;

    models.push({
      model,
      requestCount,
      tokenCount,
      cost: 0,
    });
  }

  models.sort((a, b) => b.requestCount - a.requestCount);
  return models;
}

function getTotalRequestLimit(data: BasicUsageResponse): number {
  let total = 0;
  for (const value of Object.values(data)) {
    if (!value || typeof value !== 'object') { continue; }
    const limit = (value as { maxRequestUsage?: unknown }).maxRequestUsage;
    if (typeof limit === 'number' && limit > 0) {
      total += limit;
    }
  }
  return total;
}

