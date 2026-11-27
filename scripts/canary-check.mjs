#!/usr/bin/env node
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CANARY_URL = 'https://www.perplexity.ai/rest/sse/perplexity_ask';

/**
 * Redacts any cookie, token, or authorization header values from diagnostic strings so secrets
 * can never leak into logs or automatically opened GitHub issues.
 */
export function redactCanaryDiagnostic(input) {
  return String(input || '')
    .replace(/(__Secure-next-auth\.session-token|next-auth\.csrf-token|pplx\.[^\s=;]+)\s*=\s*[^\s;,"']+/gi, '$1=[REDACTED]')
    .replace(/(Bearer|Cookie|Set-Cookie|x-csrf-token)\s*:\s*[^\r\n"']+/gi, '$1: [REDACTED]')
    .slice(0, 2000);
}

/**
 * Inspects a raw SSE body returned by Perplexity's streaming endpoint and detects wire-format drift.
 * Never includes raw user/assistant secret values in its structural summary.
 */
export function validateCanarySseBody(rawSseText) {
  const reasons = [];
  const observedEventTypes = new Set();
  const observedTopKeys = new Set();
  let jsonEventCount = 0;
  let extractedText = '';
  let sawCompletionMarker = false;

  const text = String(rawSseText || '');
  if (!text.trim()) {
    return {
      ok: false,
      drift: true,
      reasons: ['Empty response body (0 bytes).'],
      summary: { jsonEventCount: 0, eventTypes: [], topLevelKeys: [], extractedChars: 0, sawCompletionMarker: false },
    };
  }

  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    observedEventTypes.add(eventName);
    if (eventName === 'end_of_stream') {
      sawCompletionMarker = true;
      continue;
    }
    const joined = dataLines.join('\n').trim();
    if (!joined || joined === '{}' || joined === '[DONE]') {
      if (joined === '[DONE]') sawCompletionMarker = true;
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(joined);
      jsonEventCount++;
    } catch {
      reasons.push(`Malformed JSON in SSE event '${eventName}'.`);
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reasons.push(`SSE event '${eventName}' data is not a JSON object.`);
      continue;
    }

    for (const k of Object.keys(parsed)) {
      observedTopKeys.add(k);
    }

    if (parsed.text_completed === true || parsed.final === true || parsed.final_sse_message === true || parsed.status === 'COMPLETED') {
      sawCompletionMarker = true;
    }

    // Extract text from recognized Perplexity SSE payload shapes:
    // 1) `blocks` with `markdown_block.answer` / `chunks`
    // 2) `answer` string
    // 3) nested `text` JSON string containing `chunks` / `answer`
    if (typeof parsed.answer === 'string' && parsed.answer.trim()) {
      extractedText = parsed.answer;
    }
    if (Array.isArray(parsed.blocks)) {
      for (const b of parsed.blocks) {
        const md = b && typeof b === 'object' ? b.markdown_block : undefined;
        if (md && typeof md.answer === 'string' && md.answer.trim()) {
          extractedText = md.answer;
        } else if (md && Array.isArray(md.chunks) && md.chunks.length > 0) {
          extractedText = md.chunks.join('');
        }
      }
    }
    if (!extractedText && typeof parsed.text === 'string' && parsed.text.trim()) {
      if (parsed.text.trim().startsWith('{') || parsed.text.trim().startsWith('[')) {
        try {
          const inner = JSON.parse(parsed.text);
          if (typeof inner?.answer === 'string') {
            extractedText = inner.answer;
          } else if (Array.isArray(inner)) {
            for (const step of inner) {
              if (typeof step?.content?.answer === 'string') {
                extractedText = step.content.answer;
              }
            }
          }
        } catch {
          // treat as plain text only if known text field
        }
      } else if ('chunks' in parsed || 'text_completed' in parsed || 'backend_uuid' in parsed) {
        extractedText = parsed.text;
      }
    }
  }

  if (jsonEventCount === 0) {
    reasons.push('No JSON SSE data frames found in response.');
  }

  const recognizedShape =
    observedTopKeys.has('blocks') ||
    observedTopKeys.has('answer') ||
    observedTopKeys.has('text') ||
    observedTopKeys.has('chunks') ||
    observedTopKeys.has('backend_uuid');

  if (!recognizedShape) {
    reasons.push(
      `Unrecognized SSE payload schema. Observed top-level keys: [${[...observedTopKeys].sort().join(', ') || 'none'}].`
    );
  }

  if (!extractedText.trim()) {
    reasons.push('Could not extract non-empty assistant answer text from SSE frames.');
  }

  if (!sawCompletionMarker) {
    reasons.push('Missing stream completion signal (text_completed / final_sse_message / end_of_stream).');
  }

  return {
    ok: reasons.length === 0,
    drift: reasons.length > 0,
    reasons,
    summary: {
      jsonEventCount,
      eventTypes: [...observedEventTypes].sort(),
      topLevelKeys: [...observedTopKeys].sort(),
      extractedChars: extractedText.length,
      sawCompletionMarker,
    },
  };
}

export function buildRedactedCanaryIssueBody(report) {
  const lines = [
    '## Nightly Perplexity SSE Canary Alert',
    '',
    `- **Timestamp (UTC):** ${new Date().toISOString()}`,
    `- **HTTP status:** ${report.httpStatus ?? 'n/a'}`,
    `- **JSON SSE frames parsed:** ${report.summary?.jsonEventCount ?? 0}`,
    `- **Observed SSE event types:** \`${(report.summary?.eventTypes || []).join(', ') || 'none'}\``,
    `- **Observed top-level keys:** \`${(report.summary?.topLevelKeys || []).join(', ') || 'none'}\``,
    `- **Completion marker seen:** \`${Boolean(report.summary?.sawCompletionMarker)}\``,
    '',
    '### Detected format / transport issues',
    ...(report.reasons || []).map((r) => `- ${redactCanaryDiagnostic(r)}`),
    '',
    '> Redacted structural diagnostics only — zero cookies, tokens, headers, or account identifiers are included.',
  ];
  return lines.join('\n');
}

function parseCookieHeader(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('=')) {
    return trimmed.replace(/^cookie:\s*/i, '').trim();
  }
  return `__Secure-next-auth.session-token=${trimmed}`;
}

function sendCanaryRequest({ endpointUrl, cookieHeader, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(endpointUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({
      params: {
        attachments: [],
        language: 'en-US',
        timezone: 'UTC',
        search_focus: 'writing',
        sources: [],
        frontend_uuid: '00000000-0000-4000-8000-000000000040',
        frontend_context_uuid: '00000000-0000-4000-8000-000000000041',
        mode: 'concise',
        model_preference: 'turbo',
        is_related_query: false,
        is_sponsored: false,
        prompt_source: 'user',
        query_source: 'home',
        version: '2.18',
      },
      query_str: 'Reply with the single word OK.',
    });

    const req = mod.request(
      parsed,
      {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
          Cookie: cookieHeader,
          Origin: 'https://www.perplexity.ai',
          Referer: 'https://www.perplexity.ai/',
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 2 * 1024 * 1024) {
            body += chunk;
          }
        });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Canary request timed out after ${timeoutMs}ms.`)));
    req.write(payload);
    req.end();
  });
}

/**
 * Runs the canary check. When `cookie` / `PPLX_CANARY_COOKIE` is absent, returns
 * `{ skipped: true, ok: true, drift: false }` so CI workflows without secrets pass cleanly.
 */
export async function runCanaryCheck(options = {}) {
  const rawCookie =
    options.cookie !== undefined ? options.cookie : process.env.PPLX_CANARY_COOKIE || '';
  if (!String(rawCookie).trim()) {
    return {
      skipped: true,
      ok: true,
      drift: false,
      reasons: [],
      message: 'PPLX_CANARY_COOKIE is not set — skipping live canary check cleanly.',
    };
  }

  const endpointUrl = options.endpointUrl || process.env.PPLX_CANARY_URL || DEFAULT_CANARY_URL;
  const cookieHeader = parseCookieHeader(rawCookie);

  try {
    const { statusCode, body } = await sendCanaryRequest({
      endpointUrl,
      cookieHeader,
      timeoutMs: options.timeoutMs || 30_000,
    });

    if (statusCode < 200 || statusCode >= 300) {
      const report = {
        skipped: false,
        ok: false,
        drift: true,
        httpStatus: statusCode,
        reasons: [`Unexpected HTTP status ${statusCode} from SSE endpoint.`],
        summary: { jsonEventCount: 0, eventTypes: [], topLevelKeys: [], extractedChars: 0, sawCompletionMarker: false },
      };
      return { ...report, issueBody: buildRedactedCanaryIssueBody(report) };
    }

    const validation = validateCanarySseBody(body);
    const report = {
      skipped: false,
      ok: validation.ok,
      drift: validation.drift,
      httpStatus: statusCode,
      reasons: validation.reasons,
      summary: validation.summary,
    };
    return {
      ...report,
      issueBody: report.drift ? buildRedactedCanaryIssueBody(report) : undefined,
    };
  } catch (err) {
    const report = {
      skipped: false,
      ok: false,
      drift: true,
      httpStatus: 0,
      reasons: [`Network/request failure: ${redactCanaryDiagnostic(err?.message || String(err))}`],
      summary: { jsonEventCount: 0, eventTypes: [], topLevelKeys: [], extractedChars: 0, sawCompletionMarker: false },
    };
    return { ...report, issueBody: buildRedactedCanaryIssueBody(report) };
  }
}

async function cliEntry() {
  const res = await runCanaryCheck();
  const ghOutput = process.env.GITHUB_OUTPUT;

  if (res.skipped) {
    process.stdout.write(`[canary] ${res.message}\n`);
    if (ghOutput) {
      fs.appendFileSync(ghOutput, `skipped=true\ndrift=false\n`, 'utf8');
    }
    process.exitCode = 0;
    return;
  }

  if (res.ok) {
    process.stdout.write(
      `[canary] OK — HTTP ${res.httpStatus}, ${res.summary.jsonEventCount} JSON frames, keys=[${res.summary.topLevelKeys.join(', ')}].\n`
    );
    if (ghOutput) {
      fs.appendFileSync(ghOutput, `skipped=false\ndrift=false\n`, 'utf8');
    }
    process.exitCode = 0;
    return;
  }

  const issueFile = path.join(os.tmpdir(), `pcode-canary-issue-${process.pid}.md`);
  fs.writeFileSync(issueFile, res.issueBody || 'Canary format drift detected.\n', { mode: 0o600 });
  process.stderr.write(`[canary] DRIFT DETECTED:\n${res.reasons.map((r) => `  - ${redactCanaryDiagnostic(r)}`).join('\n')}\n`);

  if (ghOutput) {
    fs.appendFileSync(ghOutput, `skipped=false\ndrift=true\nissue_file=${issueFile}\n`, 'utf8');
    // Exit 0 when orchestrating inside canary.yml so the subsequent "Open GitHub Issue" step runs cleanly
    // before the workflow marks failure.
    if (process.env.PCODE_CANARY_DEFER_EXIT === '1') {
      process.exitCode = 0;
      return;
    }
  }
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void cliEntry();
}
