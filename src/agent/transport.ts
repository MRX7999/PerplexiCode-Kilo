import { ChromeCookieReader } from '../api/cookieReader';
import { CapabilityFetcher, markModelUnavailable } from '../api/capabilityFetcher';
import {
  getBaseModelId,
  getModelById,
  getModelLabel,
  getResolvedModelId,
  isThinkingModelId,
} from '../api/modelCatalog';
import { PerplexityWebClient } from '../api/perplexityClient';
import { RotationEngine } from '../api/rotationEngine';
import {
  AccountSelectionRequirements,
  AccountSession,
  FollowUpThread,
  PerplexityRequestMode,
  QueryRequestOptions,
  QuerySource,
  StreamCallbacks,
  StreamResponseMeta,
} from '../api/types';
import { AccountManager } from '../storage/accountManager';

export interface ThreadState extends FollowUpThread {
  accountId: string;
  modelId: string;
}

export interface CompletionRequest {
  /** Self-contained prompt (system prompt + full transcript). Always valid on its own. */
  fullPrompt: string;
  /** Short prompt that only makes sense as a follow-up in an existing Perplexity thread. */
  followUpPrompt?: string;
  thread?: ThreadState;
  baseModelId: string;
  thinking: boolean;
  webSearch: boolean;
  signal: AbortSignal;
  onText?: (fullText: string, delta: string) => void;
  onInfo?: (message: string) => void;
  onAccount?: (alias: string, modelLabel: string) => void;
}

export interface CompletionResult {
  text: string;
  meta: StreamResponseMeta;
  accountAlias: string;
  modelLabel: string;
  citations: string[];
  thread?: ThreadState;
  usedFollowUp: boolean;
  promptChars: number;
}

export interface StreamingClient {
  streamQuery(query: string, model: string, callbacks: StreamCallbacks, options?: QueryRequestOptions): AbortController;
}

export type ClientFactory = (account: AccountSession) => StreamingClient;

interface Attempt {
  account: AccountSession;
  modelId: string;
  requestMode: PerplexityRequestMode;
  sources: QuerySource[];
  useFollowUp: boolean;
}

export class TransportError extends Error {
  constructor(message: string, readonly kind: 'no_account' | 'aborted' | 'failed') {
    super(message);
  }
}

/**
 * Sends one agent turn to Perplexity with account rotation and the same recovery chain the
 * original chat used (session refresh, failover account, thinking -> normal, COPILOT ->
 * CONCISE, finally Best).
 */
export class PerplexityTransport {
  private emptySourcesRejected = false;

  constructor(
    private readonly accountManager: AccountManager,
    private readonly rotationEngine: RotationEngine,
    private readonly capabilityFetcher: CapabilityFetcher,
    private readonly clientFactory: ClientFactory = (account) =>
      new PerplexityWebClient(account.sessionToken, account.csrfToken, account.fullCookies)
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const accounts = this.accountManager.getAccounts();
    if (accounts.length === 0) {
      throw new TransportError('No Perplexity account is connected. Add one in Settings → Accounts.', 'no_account');
    }

    const resolvedModelId = getResolvedModelId(request.baseModelId, request.thinking);
    const model = getModelById(resolvedModelId) || getModelById(request.baseModelId) || getModelById('turbo');
    if (!model) {
      throw new TransportError('The selected model is not available.', 'failed');
    }

    const requirement = this._requirementFor(resolvedModelId);
    let account = request.thread
      ? accounts.find((entry) => entry.id === request.thread?.accountId && entry.status !== 'disabled') || null
      : null;
    if (!account) {
      account = this.rotationEngine.selectAccount(accounts, requirement);
    }
    if (!account) {
      account = this.rotationEngine.selectAccount(accounts, this._requirementFor('turbo'));
      if (account) {
        request.onInfo?.(`${model.label} is not available on your accounts right now. Using Best instead.`);
        return this._run(request, {
          account,
          modelId: 'turbo',
          requestMode: 'CONCISE',
          sources: this._sources(request.webSearch),
          useFollowUp: false,
        }, new Set());
      }
      throw new TransportError(
        'No active Perplexity account can serve this request. Check Settings → Accounts (session may be expired or rate limited).',
        'no_account'
      );
    }

    const canFollowUp = Boolean(
      request.followUpPrompt
      && request.thread
      && request.thread.accountId === account.id
      && request.thread.modelId === resolvedModelId
    );

    return this._run(request, {
      account,
      modelId: resolvedModelId,
      requestMode: model.requestMode,
      sources: this._sources(request.webSearch),
      useFollowUp: canFollowUp,
    }, new Set());
  }

  private _sources(webSearch: boolean): QuerySource[] {
    if (webSearch || this.emptySourcesRejected) {
      return ['web'];
    }
    return [];
  }

  private _requirementFor(modelId: string): AccountSelectionRequirements {
    const model = getModelById(modelId) || getModelById(getBaseModelId(modelId));
    return {
      modelId,
      featureMode: model?.searchMode || 'search',
      quotaBucket: model?.quotaBucket || (modelId === 'turbo' ? 'free_queries' : 'pro_search'),
      requiredPlan: model?.requiredPlan || 'pro',
    };
  }

  private async _run(request: CompletionRequest, attempt: Attempt, tried: Set<string>): Promise<CompletionResult> {
    const key = `${attempt.account.id}|${attempt.modelId}|${attempt.requestMode}|${attempt.sources.join(',')}|${attempt.useFollowUp}`;
    if (tried.has(key)) {
      throw new TransportError('Perplexity rejected every fallback for this request.', 'failed');
    }
    tried.add(key);

    if (request.signal.aborted) {
      throw new TransportError('Request cancelled.', 'aborted');
    }

    const prompt = attempt.useFollowUp && request.followUpPrompt ? request.followUpPrompt : request.fullPrompt;
    const modelLabel = getModelLabel(attempt.modelId);
    request.onAccount?.(attempt.account.alias, modelLabel);

    try {
      const result = await this._stream(request, attempt, prompt);
      this.rotationEngine.markUsed(attempt.account);
      this.capabilityFetcher.noteUsage(attempt.account, this._requirementFor(attempt.modelId).quotaBucket);
      await this.accountManager.saveMetas();
      const thread: ThreadState | undefined = result.meta.backendUuid
        ? {
          accountId: attempt.account.id,
          modelId: attempt.modelId,
          lastBackendUuid: result.meta.backendUuid,
          readWriteToken: result.meta.readWriteToken,
          contextUuid: result.meta.contextUuid,
        }
        : undefined;
      return {
        text: result.text,
        meta: result.meta,
        accountAlias: attempt.account.alias,
        modelLabel: result.meta.displayModel || modelLabel,
        citations: result.citations,
        thread,
        usedFollowUp: attempt.useFollowUp,
        promptChars: prompt.length,
      };
    } catch (rawError) {
      if (request.signal.aborted) {
        throw new TransportError('Request cancelled.', 'aborted');
      }
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));
      const next = await this._nextAttempt(request, attempt, error);
      if (!next) {
        await this.accountManager.saveMetas();
        throw new TransportError(error.message, 'failed');
      }
      request.onText?.('', '');
      return this._run(request, next, tried);
    }
  }

  private _stream(request: CompletionRequest, attempt: Attempt, prompt: string): Promise<{ text: string; meta: StreamResponseMeta; citations: string[] }> {
    return new Promise((resolve, reject) => {
      const client = this.clientFactory(attempt.account);
      let text = '';
      let settled = false;
      const citations = new Set<string>();
      const options: QueryRequestOptions = {
        sources: attempt.sources,
        searchMode: 'search',
        requestMode: attempt.requestMode,
        followUp: attempt.useFollowUp && request.thread ? request.thread : undefined,
      };

      const controller = client.streamQuery(prompt, attempt.modelId, {
        onChunk: (delta) => {
          if (settled) {
            return;
          }
          text += delta;
          request.onText?.(text, delta);
        },
        onCitations: (list) => list.forEach((url) => citations.add(url)),
        onDone: (fullContent, meta) => {
          if (settled) {
            return;
          }
          settled = true;
          request.signal.removeEventListener('abort', onAbort);
          const finalText = fullContent && fullContent.length >= text.length ? fullContent : text;
          if (!finalText.trim()) {
            reject(new Error('Perplexity returned an empty answer.'));
            return;
          }
          resolve({ text: finalText, meta, citations: [...citations] });
        },
        onError: (error) => {
          if (settled) {
            return;
          }
          settled = true;
          request.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      }, options);

      const onAbort = () => {
        if (!settled) {
          settled = true;
          controller.abort();
          reject(new TransportError('Request cancelled.', 'aborted'));
        }
      };
      request.signal.addEventListener('abort', onAbort);
    });
  }

  private async _nextAttempt(request: CompletionRequest, attempt: Attempt, error: Error): Promise<Attempt | undefined> {
    const lowered = error.message.toLowerCase();
    const flags = error as Error & { isAccessDenied?: boolean; isQuota?: boolean; isRateLimit?: boolean; isSession?: boolean; isCloudflare?: boolean };
    const isExpired = Boolean(flags.isSession) || ['session expired', 're-login', 'sign in again', 'authentication'].some((n) => lowered.includes(n));
    const isRateLimit = Boolean(flags.isRateLimit) || lowered.includes('rate limited') || lowered.includes('429');
    const isQuota = Boolean(flags.isQuota) || lowered.includes('quota');
    const isAccessDenied = Boolean(flags.isAccessDenied)
      || ['rejected by perplexity', 'not available for the current account', 'access denied', 'forbidden', '400'].some((n) => lowered.includes(n));
    const isEmpty = lowered.includes('empty answer');

    // 1. A broken follow-up thread: resend the self-contained prompt as a new thread.
    if (attempt.useFollowUp) {
      request.onInfo?.('Perplexity thread could not be continued. Resending the full task context.');
      return { ...attempt, useFollowUp: false };
    }

    // 2. Some accounts reject searches without sources; retry with web search enabled.
    if (attempt.sources.length === 0 && (isAccessDenied || isEmpty)) {
      this.emptySourcesRejected = true;
      return { ...attempt, sources: ['web'] };
    }

    if (isExpired) {
      this.rotationEngine.markExpired(attempt.account);
      if (await this._tryAutoRefresh(attempt.account)) {
        request.onInfo?.(`Session refreshed for ${attempt.account.alias}. Retrying.`);
        return attempt;
      }
    } else if (isRateLimit) {
      this.rotationEngine.markFailed(attempt.account, true);
    } else if (isQuota) {
      this.capabilityFetcher.noteQuotaFailure(attempt.account, this._requirementFor(attempt.modelId).quotaBucket);
    } else if (isAccessDenied) {
      markModelUnavailable(attempt.account, attempt.modelId);
    } else if (!isEmpty) {
      this.rotationEngine.markFailed(attempt.account, false);
    }

    if (isExpired || isRateLimit || isQuota || isAccessDenied) {
      const failover = this.rotationEngine.getFailoverAccount(
        this.accountManager.getAccounts(),
        attempt.account.id,
        this._requirementFor(attempt.modelId)
      );
      if (failover) {
        request.onInfo?.(`${attempt.account.alias} could not serve the request. Switching to ${failover.alias}.`);
        return { ...attempt, account: failover };
      }
    }

    if (isAccessDenied && isThinkingModelId(attempt.modelId)) {
      const baseId = getBaseModelId(attempt.modelId);
      if (baseId !== attempt.modelId && getModelById(baseId)) {
        request.onInfo?.(`Thinking variant was rejected. Retrying ${getModelLabel(baseId)} without thinking.`);
        return { ...attempt, modelId: baseId };
      }
    }

    if (isAccessDenied && attempt.requestMode === 'COPILOT') {
      return { ...attempt, requestMode: 'CONCISE' };
    }

    if ((isAccessDenied || isRateLimit || isQuota || isEmpty) && attempt.modelId !== 'turbo') {
      const turboAccount = this.rotationEngine.selectAccount(this.accountManager.getAccounts(), this._requirementFor('turbo'));
      if (turboAccount) {
        request.onInfo?.(`${getModelLabel(attempt.modelId)} is not available. Falling back to Best.`);
        return { ...attempt, account: turboAccount, modelId: 'turbo', requestMode: 'CONCISE' };
      }
    }

    // Network errors and 5xx are already retried inside PerplexityWebClient.
    return undefined;
  }

  private async _tryAutoRefresh(account: AccountSession): Promise<boolean> {
    try {
      const reader = new ChromeCookieReader();
      if (reader.isBrowserRunning()) {
        return false;
      }
      const cookies = await reader.getPerplexityCookies();
      if (!cookies) {
        return false;
      }
      return this.accountManager.updateTokens(account.id, cookies.sessionToken, cookies.csrfToken);
    } catch {
      return false;
    }
  }
}
