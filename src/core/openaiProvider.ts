import * as http from 'http';
import * as https from 'https';
import type { CompletionProvider } from '../agent/task';
import type { CompletionRequest, CompletionResult } from '../agent/transport';

/**
 * Pluggable transport #2: any OpenAI-compatible /v1/chat/completions endpoint (Ollama, LM Studio,
 * llama.cpp server, vLLM, OpenRouter, an official API). Same agent, same tools, same hooks; only
 * the model backend changes. Used with `pcode --provider openai`.
 *
 * Env: PCODE_OPENAI_BASE_URL (default http://127.0.0.1:11434/v1), PCODE_OPENAI_API_KEY (optional),
 *      PCODE_OPENAI_MODEL (default: the --model value).
 */
export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
}

export function openAIOptionsFromEnv(model?: string): OpenAICompatibleOptions {
  return {
    baseUrl: (process.env.PCODE_OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
    apiKey: process.env.PCODE_OPENAI_API_KEY || undefined,
    model: process.env.PCODE_OPENAI_MODEL || model || 'qwen2.5-coder:14b',
    temperature: process.env.PCODE_OPENAI_TEMPERATURE ? Number(process.env.PCODE_OPENAI_TEMPERATURE) : 0.2,
  };
}

export class OpenAICompatibleProvider implements CompletionProvider {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  complete(request: CompletionRequest): Promise<CompletionResult> {
    const url = new URL(`${this.options.baseUrl}/chat/completions`);
    const body = JSON.stringify({
      model: this.options.model,
      stream: true,
      temperature: this.options.temperature ?? 0.2,
      messages: [{ role: 'user', content: request.fullPrompt }],
    });
    const client = url.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let text = '';
      let buffer = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(Object.assign(error, { kind: request.signal.aborted ? 'aborted' : 'failed' }));
          return;
        }
        if (!text.trim()) {
          reject(Object.assign(new Error('The model returned an empty answer.'), { kind: 'failed' }));
          return;
        }
        resolve({
          text,
          meta: { requestedModel: this.options.model, resolvedModel: this.options.model, displayModel: this.options.model } as CompletionResult['meta'],
          accountAlias: url.host,
          modelLabel: this.options.model,
          citations: [],
          usedFollowUp: false,
          promptChars: request.fullPrompt.length,
        });
      };
      const req = client.request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        timeout: this.options.timeoutMs ?? 600_000,
      }, (res) => {
        if ((res.statusCode || 0) >= 400) {
          let errorBody = '';
          res.on('data', (chunk) => { errorBody += chunk; });
          res.on('end', () => finish(new Error(`HTTP ${res.statusCode} from ${url.host}: ${errorBody.slice(0, 300)}`)));
          return;
        }
        request.onAccount?.(url.host, this.options.model);
        const contentType = String(res.headers['content-type'] || '');
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (!contentType.includes('event-stream')) {
            buffer += chunk;
            return;
          }
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
              if (delta) {
                text += delta;
                request.onText?.(text, delta);
              }
            } catch {
              // Keep-alive or partial line.
            }
          }
        });
        res.on('end', () => {
          if (!contentType.includes('event-stream')) {
            try {
              const parsed = JSON.parse(buffer);
              text = parsed.choices?.[0]?.message?.content || '';
              if (text) request.onText?.(text, text);
            } catch (error) {
              finish(new Error(`Unexpected response from ${url.host}: ${(error as Error).message}`));
              return;
            }
          } else if (buffer.trim().startsWith('data:')) {
            const data = buffer.trim().slice(5).trim();
            if (data && data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
                if (delta) {
                  text += delta;
                  request.onText?.(text, delta);
                }
              } catch {
                // Ignore incomplete trailing line.
              }
            }
          }
          void startedAt;
          finish();
        });
        res.on('error', (error) => finish(error));
      });
      req.on('timeout', () => req.destroy(new Error('Request timed out.')));
      req.on('error', (error) => finish(error));
      request.signal.addEventListener('abort', () => {
        req.destroy();
        finish(new Error('Request cancelled.'));
      }, { once: true });
      req.end(body);
    });
  }
}
