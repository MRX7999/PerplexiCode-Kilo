import { accountCanSatisfyRequirement } from './capabilityFetcher';
import { AccountSelectionRequirements, AccountSession, RotationStrategy } from './types';

/** Conservative default per-account RPM cap (12 req/min = 1 req per 5s average ceiling). */
export const DEFAULT_MAX_REQUESTS_PER_MINUTE_PER_ACCOUNT = 12;
/** Conservative exponential backoff base delay (ms). */
export const DEFAULT_BACKOFF_BASE_MS = 1500;
/** Conservative exponential backoff cap (ms). */
export const DEFAULT_BACKOFF_MAX_MS = 30_000;

const RPM_WINDOW_MS = 60_000;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  rng?: () => number;
}

/**
 * Exponential backoff with equal jitter: returns a delay in `[0.5 * cap, 1.0 * cap]`,
 * where `cap = min(maxMs, baseMs * 2^attempt)`.
 */
export function computeBackoffWithJitterMs(attempt: number, options?: BackoffOptions): number {
  const baseMs = Math.max(50, options?.baseMs ?? DEFAULT_BACKOFF_BASE_MS);
  const maxMs = Math.max(baseMs, options?.maxMs ?? DEFAULT_BACKOFF_MAX_MS);
  const rng = options?.rng ?? Math.random;
  const exp = Math.min(10, Math.max(0, Math.floor(attempt)));
  const cap = Math.min(maxMs, baseMs * Math.pow(2, exp));
  const half = Math.floor(cap * 0.5);
  const span = Math.max(1, cap - half);
  const sample = Math.min(0.999999, Math.max(0, rng()));
  return half + Math.floor(sample * (span + 1));
}

export interface RotationEngineOptions {
  strategy?: RotationStrategy;
  maxRequestsPerMinute?: number;
  now?: () => number;
  rng?: () => number;
}

/**
 * Rotation engine that distributes requests across multiple Perplexity accounts
 * with per-account sliding-window RPM rate limiting and jittered backoff cooldowns.
 */
export class RotationEngine {
  private strategy: RotationStrategy;
  private lastUsedIndex = -1;
  private maxRequestsPerMinute: number;
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly requestTimestamps = new Map<string, number[]>();
  private readonly rateLimitStrikes = new Map<string, number>();

  constructor(strategyOrOptions: RotationStrategy | RotationEngineOptions = 'round-robin') {
    if (typeof strategyOrOptions === 'string') {
      this.strategy = strategyOrOptions;
      this.maxRequestsPerMinute = DEFAULT_MAX_REQUESTS_PER_MINUTE_PER_ACCOUNT;
      this.now = Date.now;
      this.rng = Math.random;
    } else {
      this.strategy = strategyOrOptions.strategy ?? 'round-robin';
      this.maxRequestsPerMinute = Math.max(
        1,
        Math.floor(strategyOrOptions.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE_PER_ACCOUNT)
      );
      this.now = strategyOrOptions.now ?? Date.now;
      this.rng = strategyOrOptions.rng ?? Math.random;
    }
  }

  setStrategy(strategy: RotationStrategy): void {
    this.strategy = strategy;
  }

  getStrategy(): RotationStrategy {
    return this.strategy;
  }

  setMaxRequestsPerMinute(rpm: number): void {
    if (Number.isFinite(rpm) && rpm >= 1) {
      this.maxRequestsPerMinute = Math.min(120, Math.max(1, Math.floor(rpm)));
    }
  }

  getMaxRequestsPerMinute(): number {
    return this.maxRequestsPerMinute;
  }

  private _pruneWindow(accountId: string, nowTs = this.now()): number[] {
    const list = this.requestTimestamps.get(accountId);
    if (!list || list.length === 0) {
      return [];
    }
    const cutoff = nowTs - RPM_WINDOW_MS;
    const active = list.filter((ts) => ts > cutoff);
    if (active.length !== list.length) {
      this.requestTimestamps.set(accountId, active);
    }
    return active;
  }

  getRequestsInLastMinute(accountId: string): number {
    return this._pruneWindow(accountId).length;
  }

  canSendRequest(accountId: string): boolean {
    return this._pruneWindow(accountId).length < this.maxRequestsPerMinute;
  }

  /** Records an outgoing request attempt against the account's sliding 60s RPM window. */
  recordRequest(accountId: string): void {
    const nowTs = this.now();
    const active = this._pruneWindow(accountId, nowTs);
    active.push(nowTs);
    this.requestTimestamps.set(accountId, active);
  }

  /**
   * Milliseconds until `accountId` regains an RPM slot (plus small anti-burst jitter),
   * or `0` if it can send immediately.
   */
  getMsUntilAccountSlot(accountId: string): number {
    const nowTs = this.now();
    const active = this._pruneWindow(accountId, nowTs);
    if (active.length < this.maxRequestsPerMinute) {
      return 0;
    }
    const oldestInSlot = active[active.length - this.maxRequestsPerMinute];
    const baseWait = Math.max(1, oldestInSlot + RPM_WINDOW_MS - nowTs);
    const jitter = Math.floor(this.rng() * 250) + 50;
    return baseWait + jitter;
  }

  /**
   * When every otherwise-eligible account is blocked only by the per-account RPM cap,
   * returns the shortest wait (ms) until one of those accounts frees a slot; otherwise `0`.
   */
  getMsUntilPoolSlot(accounts: AccountSession[], requirement?: AccountSelectionRequirements): number {
    const candidates = accounts.filter(
      (acc) => this._isStatusHealthy(acc) && accountCanSatisfyRequirement(acc, requirement)
    );
    if (candidates.length === 0) {
      return 0;
    }
    let shortest = Number.POSITIVE_INFINITY;
    for (const acc of candidates) {
      const wait = this.getMsUntilAccountSlot(acc.id);
      if (wait === 0) {
        return 0;
      }
      if (wait < shortest) {
        shortest = wait;
      }
    }
    return Number.isFinite(shortest) ? shortest : 0;
  }

  selectAccount(
    accounts: AccountSession[],
    requirement?: AccountSelectionRequirements
  ): AccountSession | null {
    const available = accounts.filter((account) =>
      this._isAvailable(account) && accountCanSatisfyRequirement(account, requirement)
    );

    if (available.length === 0) {
      return null;
    }

    switch (this.strategy) {
      case 'least-used':
        return this._leastUsed(available);
      case 'failover-only':
        return this._failoverOnly(available);
      case 'round-robin':
      default:
        return this._roundRobin(available, accounts, requirement);
    }
  }

  markUsed(account: AccountSession): void {
    account.lastUsedAt = new Date(this.now()).toISOString();
    account.queriestoday += 1;
    account.queriesTotalLifetime += 1;
    account.errorCount = 0;
    account.status = 'active';
    account.cooldownUntil = undefined;
    this.rateLimitStrikes.delete(account.id);
  }

  markFailed(account: AccountSession, isRateLimit: boolean): void {
    account.errorCount += 1;

    if (isRateLimit) {
      const strikes = (this.rateLimitStrikes.get(account.id) || 0) + 1;
      this.rateLimitStrikes.set(account.id, strikes);
      const cooldownMs = computeBackoffWithJitterMs(strikes - 1, {
        baseMs: 60_000,
        maxMs: 300_000,
        rng: this.rng,
      });
      account.status = 'rate_limited';
      account.cooldownUntil = new Date(this.now() + cooldownMs).toISOString();
      return;
    }

    if (account.errorCount >= 3) {
      account.status = 'error';
    }
  }

  markExpired(account: AccountSession): void {
    account.status = 'expired';
  }

  getFailoverAccount(
    accounts: AccountSession[],
    excludeId: string,
    requirement?: AccountSelectionRequirements
  ): AccountSession | null {
    const available = accounts.filter((account) =>
      account.id !== excludeId &&
      this._isAvailable(account) &&
      accountCanSatisfyRequirement(account, requirement)
    );

    if (available.length === 0) {
      return null;
    }

    return available.sort((left, right) => left.queriestoday - right.queriestoday)[0];
  }

  resetDailyCounts(accounts: AccountSession[]): void {
    for (const account of accounts) {
      account.queriestoday = 0;
      if (account.status === 'rate_limited') {
        account.status = 'active';
        account.cooldownUntil = undefined;
      }
      this.rateLimitStrikes.delete(account.id);
    }
  }

  private _isStatusHealthy(account: AccountSession): boolean {
    if (account.status === 'disabled' || account.status === 'expired' || account.status === 'error') {
      return false;
    }

    if (account.status === 'rate_limited' && account.cooldownUntil) {
      if (new Date(account.cooldownUntil).getTime() > this.now()) {
        return false;
      }
      account.status = 'active';
      account.cooldownUntil = undefined;
    }

    return true;
  }

  private _isAvailable(account: AccountSession): boolean {
    return this._isStatusHealthy(account) && this.canSendRequest(account.id);
  }

  private _roundRobin(
    available: AccountSession[],
    allAccounts: AccountSession[],
    requirement?: AccountSelectionRequirements
  ): AccountSession {
    this.lastUsedIndex = (this.lastUsedIndex + 1) % allAccounts.length;

    for (let index = 0; index < allAccounts.length; index += 1) {
      const candidateIndex = (this.lastUsedIndex + index) % allAccounts.length;
      const account = allAccounts[candidateIndex];
      if (this._isAvailable(account) && accountCanSatisfyRequirement(account, requirement)) {
        this.lastUsedIndex = candidateIndex;
        return account;
      }
    }

    return available[0];
  }

  private _leastUsed(available: AccountSession[]): AccountSession {
    return [...available].sort((left, right) => left.queriestoday - right.queriestoday)[0];
  }

  private _failoverOnly(available: AccountSession[]): AccountSession {
    return available[0];
  }
}
