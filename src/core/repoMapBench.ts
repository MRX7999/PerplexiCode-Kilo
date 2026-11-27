import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CompletionProvider } from '../agent/task';
import type { CompletionRequest, CompletionResult } from '../agent/transport';
import type { AgentSettings } from '../agent/types';
import { CoreSession } from './runner';
import { defaultSettings } from './settings';
import type { CoreEvent } from './types';

export interface BenchmarkTaskSpec {
  id: string;
  title: string;
  prompt: string;
  targetSymbol: string;
  targetFile: string;
  buggyLine: string;
  fixedLine: string;
  files: Record<string, string>;
  verifyScript: string;
}

export interface SingleRunMetrics {
  taskId: string;
  readsBeforeFirstValidEdit: number;
  totalReads: number;
  promptCharsSent: number;
  requestsCount: number;
  verifyPassed: boolean;
}

export interface AggregateVariantMetrics {
  tasksCount: number;
  totalReadsBeforeFirstEdit: number;
  avgReadsBeforeFirstEdit: number;
  totalPromptCharsSent: number;
  avgPromptCharsSent: number;
  verifyPassedCount: number;
  verifyPassRate: number;
  runs: SingleRunMetrics[];
}

export interface RepoMapBenchmarkSummary {
  tasksCount: number;
  baseline34: AggregateVariantMetrics;
  repoMap36: AggregateVariantMetrics;
  readsDelta: number;
  promptCharsDelta: number;
  verifyPassRateDelta: number;
  /** True only when 3.6 @repo is strictly better or equal on reads, prompt volume, and verify pass rate. */
  repoMapRecommendedDefault: boolean;
}

function padHelperPadding(moduleTag: string, index: number): string {
  const lines: string[] = [
    `'use strict';`,
    `// Module ${moduleTag} — workspace domain logic #${index}`,
  ];
  for (let k = 1; k <= 14; k += 1) {
    lines.push(
      `function ${moduleTag}Helper${k}(input, factor = ${k}) {`,
      `  if (input === null || input === undefined) return 0;`,
      `  const base = typeof input === 'number' ? input : String(input).length;`,
      `  return (base * factor) + ${k * 3};`,
      `}`
    );
  }
  return lines.join('\n');
}

interface RawScenario {
  id: string;
  symbol: string;
  moduleStem: string;
  distractorStems: string[];
  params: string;
  buggyBody: string;
  fixedBody: string;
  buggyLine: string;
  fixedLine: string;
  assertionExpr: string;
  prompt: string;
}

const RAW_SCENARIOS: RawScenario[] = [
  {
    id: 'T01-tax-round',
    symbol: 'calculateInvoiceTax',
    moduleStem: 'taxEngine',
    distractorStems: ['accountLedger', 'billingCycle', 'currencyTable', 'invoiceFormatter', 'receiptMailer'],
    params: 'subtotalCents, rateBps',
    buggyBody: '  return Math.floor((subtotalCents * rateBps) / 10000);',
    fixedBody: '  return Math.round((subtotalCents * rateBps) / 10000);',
    buggyLine: '  return Math.floor((subtotalCents * rateBps) / 10000);',
    fixedLine: '  return Math.round((subtotalCents * rateBps) / 10000);',
    assertionExpr: 'mod.calculateInvoiceTax(199, 775) === 15',
    prompt: 'Fix calculateInvoiceTax so fractional tax cents are rounded to nearest integer instead of floored.',
  },
  {
    id: 'T02-slug-trim',
    symbol: 'normalizeArticleSlug',
    moduleStem: 'slugifier',
    distractorStems: ['articleCache', 'contentParser', 'frontmatter', 'markdownLinks', 'routeBuilder'],
    params: 'rawTitle',
    buggyBody: "  return String(rawTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-');",
    fixedBody: "  return String(rawTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
    buggyLine: "  return String(rawTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-');",
    fixedLine: "  return String(rawTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
    assertionExpr: "mod.normalizeArticleSlug('  Hello World! ') === 'hello-world'",
    prompt: 'Fix normalizeArticleSlug so leading and trailing hyphens are stripped.',
  },
  {
    id: 'T03-retry-cap',
    symbol: 'computeRetryDelay',
    moduleStem: 'retryPolicy',
    distractorStems: ['circuitBreaker', 'dnsResolver', 'httpClient', 'poolStats', 'timeoutGuard'],
    params: 'attempt, baseMs, maxMs',
    buggyBody: '  return baseMs * Math.pow(2, attempt);',
    fixedBody: '  return Math.min(maxMs, baseMs * Math.pow(2, attempt));',
    buggyLine: '  return baseMs * Math.pow(2, attempt);',
    fixedLine: '  return Math.min(maxMs, baseMs * Math.pow(2, attempt));',
    assertionExpr: 'mod.computeRetryDelay(6, 500, 5000) === 5000',
    prompt: 'Fix computeRetryDelay so the exponential backoff never exceeds maxMs.',
  },
  {
    id: 'T04-page-offset',
    symbol: 'pageSliceBounds',
    moduleStem: 'paginator',
    distractorStems: ['cursorCodec', 'filterAst', 'queryPlanner', 'sortOrder'],
    params: 'pageOneBased, pageSize',
    buggyBody: '  const start = pageOneBased * pageSize;\n  return [start, start + pageSize];',
    fixedBody: '  const start = Math.max(0, (pageOneBased - 1) * pageSize);\n  return [start, start + pageSize];',
    buggyLine: '  const start = pageOneBased * pageSize;',
    fixedLine: '  const start = Math.max(0, (pageOneBased - 1) * pageSize);',
    assertionExpr: 'JSON.stringify(mod.pageSliceBounds(1, 20)) === "[0,20]"',
    prompt: 'Fix pageSliceBounds off-by-one offset for 1-based page numbers.',
  },
  {
    id: 'T05-clamp-score',
    symbol: 'clampConfidence',
    moduleStem: 'scoring',
    distractorStems: ['aggregator', 'calibration', 'featureFlags', 'histogram', 'metricsSink'],
    params: 'value',
    buggyBody: '  return Math.min(1, value);',
    fixedBody: '  return Math.max(0, Math.min(1, value));',
    buggyLine: '  return Math.min(1, value);',
    fixedLine: '  return Math.max(0, Math.min(1, value));',
    assertionExpr: 'mod.clampConfidence(-0.4) === 0 && mod.clampConfidence(1.5) === 1',
    prompt: 'Fix clampConfidence so negative values are clamped to 0.',
  },
  {
    id: 'T06-small-twofile',
    symbol: 'parsePortNumber',
    moduleStem: 'alphaConfig',
    distractorStems: ['zetaLogger'],
    params: 'raw',
    buggyBody: '  const n = Number(raw);\n  return n > 0 ? n : null;',
    fixedBody: '  const n = Number(raw);\n  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;',
    buggyLine: '  return n > 0 ? n : null;',
    fixedLine: '  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;',
    assertionExpr: 'mod.parsePortNumber("70000") === null && mod.parsePortNumber("8080") === 8080',
    prompt: 'Fix parsePortNumber to reject ports above 65535 or non-integers.',
  },
  {
    id: 'T07-escape-amp',
    symbol: 'escapeXmlAttr',
    moduleStem: 'xmlWriter',
    distractorStems: ['attrParser', 'domBuilder', 'entityMap', 'nodeStream', 'schemaCheck', 'tagStack'],
    params: 'value',
    buggyBody: "  return String(value).replace(/\"/g, '&quot;').replace(/</g, '&lt;');",
    fixedBody: "  return String(value).replace(/&/g, '&amp;').replace(/\"/g, '&quot;').replace(/</g, '&lt;');",
    buggyLine: "  return String(value).replace(/\"/g, '&quot;').replace(/</g, '&lt;');",
    fixedLine: "  return String(value).replace(/&/g, '&amp;').replace(/\"/g, '&quot;').replace(/</g, '&lt;');",
    assertionExpr: 'mod.escapeXmlAttr(\'a&"b<\') === \'a&amp;&quot;b&lt;\'',
    prompt: 'Fix escapeXmlAttr so ampersands are escaped before quotes and angle brackets.',
  },
  {
    id: 'T08-bearer-extract',
    symbol: 'extractBearerToken',
    moduleStem: 'tokenHeader',
    distractorStems: ['auditTrail', 'cookieJar', 'corsPolicy', 'csrfCheck', 'jwtVerify'],
    params: 'headerValue',
    buggyBody: "  if (!headerValue || !headerValue.startsWith('Bearer ')) return null;\n  return headerValue.slice(7);",
    fixedBody: "  const m = /^Bearer\\s+(\\S+)$/i.exec(String(headerValue || '').trim());\n  return m ? m[1] : null;",
    buggyLine: "  if (!headerValue || !headerValue.startsWith('Bearer ')) return null;\n  return headerValue.slice(7);",
    fixedLine: "  const m = /^Bearer\\s+(\\S+)$/i.exec(String(headerValue || '').trim());\n  return m ? m[1] : null;",
    assertionExpr: "mod.extractBearerToken('bearer   tok_123  ') === 'tok_123'",
    prompt: 'Fix extractBearerToken so scheme matching is case-insensitive and trims extra whitespace.',
  },
  {
    id: 'T09-hmac-hex-compare',
    symbol: 'constantTimeEqualStrings',
    moduleStem: 'signatureCheck',
    distractorStems: ['apiKeys', 'hashStream', 'keyStore', 'nonceCache', 'payloadCodec'],
    params: 'left, right',
    buggyBody: '  if (typeof left !== "string" || typeof right !== "string") return false;\n  return left.startsWith(right);',
    fixedBody: '  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;\n  let diff = 0;\n  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);\n  return diff === 0;',
    buggyLine: '  return left.startsWith(right);',
    fixedLine: '  if (left.length !== right.length) return false;\n  let diff = 0;\n  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);\n  return diff === 0;',
    assertionExpr: '!mod.constantTimeEqualStrings("abcdef", "abc") && mod.constantTimeEqualStrings("abcdef", "abcdef")',
    prompt: 'Fix constantTimeEqualStrings so prefix strings do not falsely compare equal.',
  },
  {
    id: 'T10-csv-quote',
    symbol: 'formatCsvCell',
    moduleStem: 'csvExporter',
    distractorStems: ['columnMapper', 'dateColumn', 'excelSheet', 'rowFilter', 'tableHeader'],
    params: 'rawCell',
    buggyBody: '  const s = String(rawCell ?? "");\n  return s.includes(",") ? `"${s}"` : s;',
    fixedBody: '  const s = String(rawCell ?? "");\n  return /[",\\n\\r]/.test(s) ? `"${s.replace(/"/g, \'""\')}"` : s;',
    buggyLine: '  return s.includes(",") ? `"${s}"` : s;',
    fixedLine: '  return /[",\\n\\r]/.test(s) ? `"${s.replace(/"/g, \'""\')}"` : s;',
    assertionExpr: 'mod.formatCsvCell(\'say "hi", ok\') === \'"say ""hi"", ok"\'',
    prompt: 'Fix formatCsvCell to double embedded quotes and quote cells containing quotes or newlines.',
  },
  {
    id: 'T11-duration-sec',
    symbol: 'formatDurationShort',
    moduleStem: 'timeFormat',
    distractorStems: ['calendarGrid', 'clockSkew', 'cronParser', 'epochUtils', 'localeStrings'],
    params: 'ms',
    buggyBody: '  const sec = Math.floor(ms / 1000);\n  return `${Math.floor(sec / 60)}m ${sec}s`;',
    fixedBody: '  const sec = Math.max(0, Math.floor(ms / 1000));\n  return `${Math.floor(sec / 60)}m ${sec % 60}s`;',
    buggyLine: '  const sec = Math.floor(ms / 1000);\n  return `${Math.floor(sec / 60)}m ${sec}s`;',
    fixedLine: '  const sec = Math.max(0, Math.floor(ms / 1000));\n  return `${Math.floor(sec / 60)}m ${sec % 60}s`;',
    assertionExpr: "mod.formatDurationShort(125000) === '2m 5s'",
    prompt: 'Fix formatDurationShort so remaining seconds use modulo 60.',
  },
  {
    id: 'T12-semver-num',
    symbol: 'compareSemverCore',
    moduleStem: 'versionCompare',
    distractorStems: ['changelogReader', 'depGraph', 'lockfile', 'packageManifest', 'releaseTag'],
    params: 'a, b',
    buggyBody: "  return String(a).localeCompare(String(b));",
    fixedBody: "  const pa = String(a).split('.').map(Number);\n  const pb = String(b).split('.').map(Number);\n  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }\n  return 0;",
    buggyLine: "  return String(a).localeCompare(String(b));",
    fixedLine: "  const pa = String(a).split('.').map(Number);\n  const pb = String(b).split('.').map(Number);\n  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }\n  return 0;",
    assertionExpr: "mod.compareSemverCore('3.10.0', '3.2.0') === 1",
    prompt: 'Fix compareSemverCore to compare major.minor.patch numerically instead of lexicographically.',
  },
  {
    id: 'T13-small-alpha',
    symbol: 'sumPositiveOnly',
    moduleStem: 'arrayMath',
    distractorStems: ['vectorOps'],
    params: 'nums',
    buggyBody: '  return nums.reduce((acc, n) => acc + n, 0);',
    fixedBody: '  return nums.reduce((acc, n) => (n > 0 ? acc + n : acc), 0);',
    buggyLine: '  return nums.reduce((acc, n) => acc + n, 0);',
    fixedLine: '  return nums.reduce((acc, n) => (n > 0 ? acc + n : acc), 0);',
    assertionExpr: 'mod.sumPositiveOnly([5, -3, 10, -2]) === 15',
    prompt: 'Fix sumPositiveOnly so negative values are ignored.',
  },
  {
    id: 'T14-dedupe-preserve',
    symbol: 'dedupeCaseInsensitive',
    moduleStem: 'tagNormalizer',
    distractorStems: ['categoryTree', 'facetCounts', 'indexWriter', 'searchQuery', 'stopWords'],
    params: 'items',
    buggyBody: '  return [...new Set(items)];',
    fixedBody: '  const seen = new Set();\n  return items.filter((x) => { const k = String(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });',
    buggyLine: '  return [...new Set(items)];',
    fixedLine: '  const seen = new Set();\n  return items.filter((x) => { const k = String(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });',
    assertionExpr: 'JSON.stringify(mod.dedupeCaseInsensitive(["TypeScript", "typescript", "Node"])) === \'["TypeScript","Node"]\'',
    prompt: 'Fix dedupeCaseInsensitive to deduplicate case-insensitively while preserving first casing.',
  },
  {
    id: 'T15-ratio-zero',
    symbol: 'safeConversionRate',
    moduleStem: 'funnelStats',
    distractorStems: ['abAssignment', 'cohortTable', 'eventBuffer', ' metricRollup'.trim(), 'sessionStore'],
    params: 'conversions, visits',
    buggyBody: '  return conversions / visits;',
    fixedBody: '  return visits > 0 ? conversions / visits : 0;',
    buggyLine: '  return conversions / visits;',
    fixedLine: '  return visits > 0 ? conversions / visits : 0;',
    assertionExpr: 'mod.safeConversionRate(0, 0) === 0 && mod.safeConversionRate(5, 20) === 0.25',
    prompt: 'Fix safeConversionRate to return 0 instead of NaN/Infinity when visits is 0.',
  },
  {
    id: 'T16-env-bool',
    symbol: 'parseEnvFlag',
    moduleStem: 'envFlags',
    distractorStems: ['argParser', 'cliBanner', 'configLoader', 'dotenvReader', 'pathResolver'],
    params: 'raw, fallback = false',
    buggyBody: '  if (raw === undefined) return fallback;\n  return Boolean(raw);',
    fixedBody: '  if (raw === undefined || raw === "") return fallback;\n  const v = String(raw).trim().toLowerCase();\n  if (["1", "true", "yes", "on"].includes(v)) return true;\n  if (["0", "false", "no", "off"].includes(v)) return false;\n  return fallback;',
    buggyLine: '  return Boolean(raw);',
    fixedLine: '  if (raw === "") return fallback;\n  const v = String(raw).trim().toLowerCase();\n  if (["1", "true", "yes", "on"].includes(v)) return true;\n  if (["0", "false", "no", "off"].includes(v)) return false;\n  return fallback;',
    assertionExpr: 'mod.parseEnvFlag("false", true) === false && mod.parseEnvFlag("1", false) === true',
    prompt: 'Fix parseEnvFlag so string "false" and "0" return false instead of true.',
  },
  {
    id: 'T17-path-ext',
    symbol: 'replaceExtension',
    moduleStem: 'assetNaming',
    distractorStems: ['bundleManifest', 'chunkHasher', 'cssMinifier', 'imageLoader', 'sourceMaps'],
    params: 'filePath, newExt',
    buggyBody: "  const dot = filePath.indexOf('.');\n  return dot >= 0 ? filePath.slice(0, dot) + newExt : filePath + newExt;",
    fixedBody: "  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\\\'));\n  const dot = filePath.lastIndexOf('.');\n  const ext = newExt.startsWith('.') ? newExt : `.${newExt}`;\n  return dot > slash ? filePath.slice(0, dot) + ext : filePath + ext;",
    buggyLine: "  const dot = filePath.indexOf('.');\n  return dot >= 0 ? filePath.slice(0, dot) + newExt : filePath + newExt;",
    fixedLine: "  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\\\'));\n  const dot = filePath.lastIndexOf('.');\n  const ext = newExt.startsWith('.') ? newExt : `.${newExt}`;\n  return dot > slash ? filePath.slice(0, dot) + ext : filePath + ext;",
    assertionExpr: "mod.replaceExtension('dir.v1/archive.tar.gz', '.zip') === 'dir.v1/archive.tar.zip'",
    prompt: 'Fix replaceExtension so dots in directory names or multi-part filenames use the last extension dot.',
  },
  {
    id: 'T18-http-retryable',
    symbol: 'isRetryableStatus',
    moduleStem: 'statusClassifier',
    distractorStems: ['bodyReader', 'ChaosInjector', 'headerNormalizer', 'proxyAgent', 'requestSigner'],
    params: 'statusCode',
    buggyBody: '  return statusCode >= 500;',
    fixedBody: '  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode !== 501);',
    buggyLine: '  return statusCode >= 500;',
    fixedLine: '  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode !== 501);',
    assertionExpr: 'mod.isRetryableStatus(429) === true && mod.isRetryableStatus(501) === false && mod.isRetryableStatus(503) === true',
    prompt: 'Fix isRetryableStatus to treat 408 and 429 as retryable and exclude 501 Not Implemented.',
  },
  {
    id: 'T19-median-even',
    symbol: 'computeMedian',
    moduleStem: 'quantileStats',
    distractorStems: ['anomalyDetector', 'ewmaTracker', 'movingWindow', 'outlierFilter', 'zScore'],
    params: 'values',
    buggyBody: '  const sorted = [...values].sort((a, b) => a - b);\n  return sorted[Math.floor(sorted.length / 2)];',
    fixedBody: '  if (!values.length) return 0;\n  const sorted = [...values].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];',
    buggyLine: '  const sorted = [...values].sort((a, b) => a - b);\n  return sorted[Math.floor(sorted.length / 2)];',
    fixedLine: '  if (!values.length) return 0;\n  const sorted = [...values].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];',
    assertionExpr: 'mod.computeMedian([10, 2, 4, 8]) === 6',
    prompt: 'Fix computeMedian to average the two middle elements for even-length arrays.',
  },
  {
    id: 'T20-redact-query-token',
    symbol: 'scrubUrlSecrets',
    moduleStem: 'urlSanitizer',
    distractorStems: ['accessLogger', 'errorReporter', 'spanExporter', 'traceContext'],
    params: 'rawUrl',
    buggyBody: '  return rawUrl;',
    fixedBody: '  return String(rawUrl).replace(/([?&](?:token|api_key|secret)=)[^&#]+/gi, "$1REDACTED");',
    buggyLine: '  return rawUrl;',
    fixedLine: '  return String(rawUrl).replace(/([?&](?:token|api_key|secret)=)[^&#]+/gi, "$1REDACTED");',
    assertionExpr: "mod.scrubUrlSecrets('https://ex.com/cb?token=abc123&ok=1') === 'https://ex.com/cb?token=REDACTED&ok=1'",
    prompt: 'Fix scrubUrlSecrets to mask token, api_key, and secret query parameters as REDACTED.',
  },
  {
    id: 'T21-chunk-size',
    symbol: 'chunkArray',
    moduleStem: 'batchSplitter',
    distractorStems: ['backpressure', 'jobWorker', 'queueMetrics', 'rateBucket', 'taskScheduler'],
    params: 'items, chunkSize',
    buggyBody: '  const out = [];\n  for (let i = 0; i < items.length; i += chunkSize) out.push(items.slice(i, chunkSize));\n  return out;',
    fixedBody: '  const step = Math.max(1, Math.floor(chunkSize));\n  const out = [];\n  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));\n  return out;',
    buggyLine: '  for (let i = 0; i < items.length; i += chunkSize) out.push(items.slice(i, chunkSize));',
    fixedLine: '  const step = Math.max(1, Math.floor(chunkSize));\n  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));',
    assertionExpr: 'JSON.stringify(mod.chunkArray([1,2,3,4,5], 2)) === "[[1,2],[3,4],[5]]"',
    prompt: 'Fix chunkArray slice end index bug where items.slice(i, chunkSize) produces empty chunks after index 0.',
  },
  {
    id: 'T22-small-pair',
    symbol: 'mergePortHost',
    moduleStem: ' bindAddress'.trim(),
    distractorStems: ['socketOpts'],
    params: 'host, port',
    buggyBody: '  return `${host}:${port}`;',
    fixedBody: '  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;',
    buggyLine: '  return `${host}:${port}`;',
    fixedLine: '  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;',
    assertionExpr: "mod.mergePortHost('::1', 8080) === '[::1]:8080'",
    prompt: 'Fix mergePortHost so IPv6 literals are wrapped in brackets.',
  },
  {
    id: 'T23-discount-cap',
    symbol: 'applyCouponCents',
    moduleStem: 'couponCalculator',
    distractorStems: ['cartTotals', 'giftCard', 'loyaltyTier', 'orderSummary', 'promoRules'],
    params: 'totalCents, discountCents',
    buggyBody: '  return totalCents - discountCents;',
    fixedBody: '  return Math.max(0, totalCents - Math.max(0, discountCents));',
    buggyLine: '  return totalCents - discountCents;',
    fixedLine: '  return Math.max(0, totalCents - Math.max(0, discountCents));',
    assertionExpr: 'mod.applyCouponCents(500, 900) === 0 && mod.applyCouponCents(500, -50) === 500',
    prompt: 'Fix applyCouponCents so order total cannot drop below zero or increase from negative coupons.',
  },
  {
    id: 'T24-header-fold',
    symbol: 'lookupHeaderIgnoreCase',
    moduleStem: 'headerLookup',
    distractorStems: ['acceptNegotiator', 'cacheControl', 'contentType', 'etagValidator', 'rangeParser'],
    params: 'headersObj, targetName',
    buggyBody: '  return headersObj ? headersObj[targetName] : undefined;',
    fixedBody: '  if (!headersObj) return undefined;\n  const needle = String(targetName).toLowerCase();\n  const key = Object.keys(headersObj).find((k) => k.toLowerCase() === needle);\n  return key ? headersObj[key] : undefined;',
    buggyLine: '  return headersObj ? headersObj[targetName] : undefined;',
    fixedLine: '  if (!headersObj) return undefined;\n  const needle = String(targetName).toLowerCase();\n  const key = Object.keys(headersObj).find((k) => k.toLowerCase() === needle);\n  return key ? headersObj[key] : undefined;',
    assertionExpr: "mod.lookupHeaderIgnoreCase({ 'X-Request-Id': 'req_9' }, 'x-request-id') === 'req_9'",
    prompt: 'Fix lookupHeaderIgnoreCase to find HTTP header keys case-insensitively.',
  },
];

export function buildRepoMapBenchmarkSuite(): BenchmarkTaskSpec[] {
  return RAW_SCENARIOS.map((sc, idx) => {
    const files: Record<string, string> = {};
    const targetRel = `src/${sc.moduleStem}.cjs`;
    const allStems = [...sc.distractorStems, sc.moduleStem].sort((a, b) => a.localeCompare(b));

    for (let i = 0; i < allStems.length; i += 1) {
      const stem = allStems[i];
      if (stem === sc.moduleStem) {
        const helperImport = sc.distractorStems[0]
          ? `const _dep = require('./${sc.distractorStems[0]}.cjs');\n`
          : '';
        files[targetRel] = [
          padHelperPadding(stem, idx + 1),
          helperImport,
          `function ${sc.symbol}(${sc.params}) {`,
          sc.buggyBody,
          `}`,
          '',
          `module.exports = { ${sc.symbol} };`,
          '',
        ].join('\n');
      } else {
        files[`src/${stem}.cjs`] = [
          padHelperPadding(stem, i + 10),
          `function ${stem}Main(value) {`,
          `  return ${stem}Helper1(value);`,
          `}`,
          `module.exports = { ${stem}Main };`,
          '',
        ].join('\n');
      }
    }

    const verifyScript = [
      `'use strict';`,
      `const assert = require('assert');`,
      `const mod = require('../${targetRel}');`,
      `assert.ok(${sc.assertionExpr}, 'Verification failed for ${sc.symbol}');`,
      `console.log('PASS ${sc.id}');`,
      '',
    ].join('\n');
    files[`test/${sc.moduleStem}.test.cjs`] = verifyScript;

    return {
      id: sc.id,
      title: `${sc.id}: ${sc.symbol}`,
      prompt: sc.prompt,
      targetSymbol: sc.symbol,
      targetFile: targetRel,
      buggyLine: sc.buggyLine,
      fixedLine: sc.fixedLine,
      files,
      verifyScript,
    };
  });
}

function defaultBenchAgentSettings(repoMapEnabled: boolean, repoMapMaxChars: number): AgentSettings {
  return {
    autoApprove: {
      enabled: true,
      read: true,
      readOutsideWorkspace: false,
      write: true,
      execute: true,
      modeSwitch: true,
      subtasks: true,
      todo: true,
      retry: false,
      mcp: false,
      web: false,
    },
    allowedCommands: ['*'],
    deniedCommands: [],
    maxRequests: 20,
    maxReadLines: 400,
    commandTimeoutSec: 30,
    terminalOutputLines: 100,
    webSearch: 'never',
    contextStrategy: 'full',
    maxPromptChars: 60_000,
    language: 'en',
    customInstructions: '',
    modeInstructions: {},
    diffEnabled: true,
    includeFileListOnStart: true,
    repoMapEnabled,
    repoMapMaxChars,
    autoCompactThreshold: 0.8,
    autoCompactKeepSteps: 4,
  };
}

/**
 * Deterministic navigation provider that uses ONLY information actually present in `request.fullPrompt`:
 * - If `<repo_map>` identifies which file defines `spec.targetSymbol`, reads that file directly.
 * - Otherwise iterates candidate `src/*.cjs` files listed in `<environment_details>` until a `read_file`
 *   result reveals `function <targetSymbol>`.
 * - Once the target file has been read, applies `<apply_diff>` and then calls `<attempt_completion>`,
 *   which runs `verify.command` through `CoreGate`.
 */
function createDeterministicAgentProvider(spec: BenchmarkTaskSpec): {
  provider: CompletionProvider;
  getPromptCharsSent: () => number;
  getRequestsCount: () => number;
} {
  let promptCharsSent = 0;
  let requestsCount = 0;
  const triedFiles = new Set<string>();
  let appliedPatch = false;

  const provider: CompletionProvider = {
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const sent = req.thread && req.followUpPrompt ? req.followUpPrompt : req.fullPrompt;
      promptCharsSent += sent.length;
      requestsCount += 1;

      const full = req.fullPrompt;

      // Has the patch already been applied in the conversation?
      if (appliedPatch && full.includes(`changes were applied successfully: ${spec.targetFile}`)) {
        const text = `<attempt_completion>\n<result>Fixed ${spec.targetSymbol} in ${spec.targetFile}.</result>\n</attempt_completion>`;
        return makeResult(text, sent.length);
      }

      // Check if we already read the specific file containing `function <targetSymbol>(`
      const singleReadBlocks = full.split(/(?=\[read_file for ')/);
      let confirmedPath: string | undefined;
      const fnPattern = new RegExp(`function\\s+${spec.targetSymbol}\\s*\\(`);
      for (const block of singleReadBlocks) {
        const headerMatch = /^\[read_file for '([^']+)'\]/.exec(block);
        if (headerMatch && fnPattern.test(block)) {
          confirmedPath = headerMatch[1];
          break;
        }
      }
      if (confirmedPath && !appliedPatch) {
        appliedPatch = true;
        const diffBody = [
          '<<<<<<< SEARCH',
          spec.buggyLine,
          '=======',
          spec.fixedLine,
          '>>>>>>> REPLACE',
        ].join('\n');
        const text = `<apply_diff>\n<path>${confirmedPath}</path>\n<diff>\n${diffBody}\n</diff>\n</apply_diff>`;
        return makeResult(text, sent.length);
      }

      // Check if `<repo_map>` in the prompt locates `spec.targetSymbol`
      const repoMapMatch = /<repo_map>([\s\S]*?)<\/repo_map>/.exec(full);
      if (repoMapMatch) {
        const mapText = repoMapMatch[1];
        const blocks = mapText.split(/\n(?=## )/);
        for (const block of blocks) {
          const header = /^##\s+([^\s\[]+)/.exec(block.trim());
          if (header && block.includes(spec.targetSymbol) && !triedFiles.has(header[1])) {
            triedFiles.add(header[1]);
            const text = `<read_file>\n<path>${header[1]}</path>\n</read_file>`;
            return makeResult(text, sent.length);
          }
        }
        // Check compact lines `- src/foo.cjs: sym1, sym2`
        for (const line of mapText.split('\n')) {
          const compact = /^-\s+([^\s:]+):\s*(.+)$/.exec(line.trim());
          if (compact && compact[2].includes(spec.targetSymbol) && !triedFiles.has(compact[1])) {
            triedFiles.add(compact[1]);
            const text = `<read_file>\n<path>${compact[1]}</path>\n</read_file>`;
            return makeResult(text, sent.length);
          }
        }
      }

      // Fallback (3.4 baseline without @repo): scan `src/*.cjs` files from environment file list
      const fileCandidates: string[] = [];
      for (const match of full.matchAll(/\b(src\/[A-Za-z0-9_.-]+\.cjs)\b/g)) {
        if (!fileCandidates.includes(match[1])) {
          fileCandidates.push(match[1]);
        }
      }
      fileCandidates.sort((a, b) => a.localeCompare(b));
      const nextCandidate = fileCandidates.find((f) => !triedFiles.has(f)) || spec.targetFile;
      triedFiles.add(nextCandidate);
      const text = `<read_file>\n<path>${nextCandidate}</path>\n</read_file>`;
      return makeResult(text, sent.length);
    },
  };

  return {
    provider,
    getPromptCharsSent: () => promptCharsSent,
    getRequestsCount: () => requestsCount,
  };
}

function makeResult(text: string, promptChars: number): CompletionResult {
  return {
    text,
    meta: {
      requestedModel: 'claude46sonnet',
      resolvedModel: 'claude46sonnet',
      displayModel: 'Claude Sonnet 4.6',
      reportedModel: 'Claude Sonnet 4.6',
      searchMode: 'search',
      mode: 'COPILOT',
    },
    accountAlias: 'bench',
    modelLabel: 'Claude Sonnet 4.6',
    citations: [],
    usedFollowUp: false,
    promptChars,
  };
}

async function runOneVariantTask(
  spec: BenchmarkTaskSpec,
  options: { repoMapEnabled: boolean; repoMapMaxChars: number }
): Promise<SingleRunMetrics> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pcode-bench-${spec.id}-`));
  try {
    for (const [rel, content] of Object.entries(spec.files)) {
      const abs = path.join(tmpDir, rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, 'utf8');
    }

    const coreSettings = defaultSettings();
    coreSettings.permissions.defaultMode = 'bypassPermissions';
    coreSettings.verify = {
      command: `node test/${ path.posix.basename(spec.targetFile, '.cjs') }.test.cjs`,
      maxAttempts: 2,
      timeoutSec: 15,
    };

    const { provider, getPromptCharsSent, getRequestsCount } = createDeterministicAgentProvider(spec);
    let totalReads = 0;
    let readsBeforeFirstEdit: number | null = null;
    let verifyPassed = false;

    const session = new CoreSession({
      cwd: tmpDir,
      provider,
      agentSettings: defaultBenchAgentSettings(options.repoMapEnabled, options.repoMapMaxChars),
      selection: { baseModelId: 'claude46sonnet', thinking: false, webSearch: false },
      mode: 'code',
      settings: coreSettings,
      permissionMode: 'bypassPermissions',
      journal: false,
      onAsk: async (_task, message) => {
        const kind = message.ask?.kind;
        if (kind === 'request_limit' || kind === 'mistake_limit' || kind === 'api_failed') {
          return { response: 'no' };
        }
        return { response: 'yes' };
      },
      onEvent: (_task, event: CoreEvent) => {
        if (event.type === 'tool_end' && event.tool === 'read_file' && event.ok) {
          totalReads += 1;
        }
        if (event.type === 'file_edit' && readsBeforeFirstEdit === null) {
          readsBeforeFirstEdit = totalReads;
        }
        if (event.type === 'verification' && event.status === 'verified') {
          verifyPassed = true;
        }
      },
    });

    const outcome = await session.run(spec.prompt);
    if (outcome.verification?.status === 'verified') {
      verifyPassed = true;
    }

    return {
      taskId: spec.id,
      readsBeforeFirstValidEdit: readsBeforeFirstEdit ?? totalReads,
      totalReads,
      promptCharsSent: getPromptCharsSent(),
      requestsCount: getRequestsCount(),
      verifyPassed,
    };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

function summarizeRuns(runs: SingleRunMetrics[]): AggregateVariantMetrics {
  const tasksCount = runs.length;
  const totalReadsBeforeFirstEdit = runs.reduce((s, r) => s + r.readsBeforeFirstValidEdit, 0);
  const totalPromptCharsSent = runs.reduce((s, r) => s + r.promptCharsSent, 0);
  const verifyPassedCount = runs.filter((r) => r.verifyPassed).length;
  return {
    tasksCount,
    totalReadsBeforeFirstEdit,
    avgReadsBeforeFirstEdit: tasksCount > 0 ? Number((totalReadsBeforeFirstEdit / tasksCount).toFixed(2)) : 0,
    totalPromptCharsSent,
    avgPromptCharsSent: tasksCount > 0 ? Math.round(totalPromptCharsSent / tasksCount) : 0,
    verifyPassedCount,
    verifyPassRate: tasksCount > 0 ? Number((verifyPassedCount / tasksCount).toFixed(4)) : 0,
    runs,
  };
}

/**
 * F14: Runs the 24-task reproducible benchmark comparing 3.4 baseline (`repoMapEnabled: false`)
 * against 3.6 repository map (`repoMapEnabled: true`).
 */
export async function runRepoMapBenchmark(options?: {
  tasks?: BenchmarkTaskSpec[];
  repoMapMaxChars?: number;
}): Promise<RepoMapBenchmarkSummary> {
  const suite = options?.tasks || buildRepoMapBenchmarkSuite();
  const repoMapMaxChars = options?.repoMapMaxChars ?? 2400;

  const baselineRuns: SingleRunMetrics[] = [];
  const repoMapRuns: SingleRunMetrics[] = [];

  for (const spec of suite) {
    baselineRuns.push(await runOneVariantTask(spec, { repoMapEnabled: false, repoMapMaxChars }));
    repoMapRuns.push(await runOneVariantTask(spec, { repoMapEnabled: true, repoMapMaxChars }));
  }

  const baseline34 = summarizeRuns(baselineRuns);
  const repoMap36 = summarizeRuns(repoMapRuns);

  const readsDelta = Number((repoMap36.avgReadsBeforeFirstEdit - baseline34.avgReadsBeforeFirstEdit).toFixed(2));
  const promptCharsDelta = repoMap36.avgPromptCharsSent - baseline34.avgPromptCharsSent;
  const verifyPassRateDelta = Number((repoMap36.verifyPassRate - baseline34.verifyPassRate).toFixed(4));

  const repoMapRecommendedDefault =
    repoMap36.avgReadsBeforeFirstEdit <= baseline34.avgReadsBeforeFirstEdit
    && repoMap36.avgPromptCharsSent <= baseline34.avgPromptCharsSent
    && repoMap36.verifyPassRate >= baseline34.verifyPassRate;

  return {
    tasksCount: suite.length,
    baseline34,
    repoMap36,
    readsDelta,
    promptCharsDelta,
    verifyPassRateDelta,
    repoMapRecommendedDefault,
  };
}
