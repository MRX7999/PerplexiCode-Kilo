import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import {
  buildModelsFromConfig,
  getFallbackModelCatalog,
  ModelInfo,
  setVerifiedRemoteModelsConfig,
} from './modelCatalog';
import { normalizeModelsConfigPayload } from './modelsConfigFetcher';
import { PerplexityModelsConfigSnapshot } from './types';

export const DEFAULT_REMOTE_CATALOG_URL =
  'https://raw.githubusercontent.com/MRX7999/PerplexiCode-Kilo/master/src/api/bundledModelsConfig.json';
export const DEFAULT_REMOTE_CATALOG_SHA256_URL =
  'https://raw.githubusercontent.com/MRX7999/PerplexiCode-Kilo/master/src/api/bundledModelsConfig.json.sha256';

export class CatalogVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogVerificationError';
  }
}

export function parseSha256Digest(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new CatalogVerificationError('Empty SHA-256 manifest.');
  }
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as { sha256?: string };
      if (typeof obj.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(obj.sha256.trim())) {
        return obj.sha256.trim().toLowerCase();
      }
    } catch {
      // fall through
    }
  }
  const match = /^([a-fA-F0-9]{64})(?:\s+.*)?$/m.exec(trimmed);
  if (!match) {
    throw new CatalogVerificationError('Invalid SHA-256 manifest format: expected 64-character hex digest.');
  }
  return match[1].toLowerCase();
}

export function verifyAndParseRemoteCatalog(
  rawJsonBytes: Buffer,
  expectedSha256Input: string
): {
  sha256: string;
  snapshotDate?: string;
  config: PerplexityModelsConfigSnapshot;
  models: ModelInfo[];
} {
  const expectedHex = parseSha256Digest(expectedSha256Input);
  const actualHex = createHash('sha256').update(rawJsonBytes).digest('hex').toLowerCase();

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(actualHex, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new CatalogVerificationError(
      `Model catalog SHA-256 mismatch: expected ${expectedHex}, got ${actualHex}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonBytes.toString('utf8'));
  } catch (err) {
    throw new CatalogVerificationError(`Remote model catalog is not valid JSON: ${(err as Error).message}`);
  }

  const normalized = normalizeModelsConfigPayload(parsed);
  if (!normalized || !normalized.models || Object.keys(normalized.models).length === 0) {
    throw new CatalogVerificationError('Remote model catalog failed schema validation (empty models map).');
  }

  const models = buildModelsFromConfig(normalized, 'unknown');
  if (models.length === 0) {
    throw new CatalogVerificationError('Remote model catalog built zero usable models.');
  }

  const snapshotDate =
    typeof (parsed as { snapshot_date?: unknown })?.snapshot_date === 'string'
      ? ((parsed as { snapshot_date: string }).snapshot_date)
      : undefined;

  return {
    sha256: actualHex,
    snapshotDate,
    config: normalized,
    models,
  };
}

function defaultCacheFile(cacheDir?: string): string {
  const base = cacheDir || path.join(process.env.HOME || os.homedir(), '.perplexicode');
  return path.join(base, 'models-catalog-cache.json');
}

function fetchBytes(urlStr: string, timeoutMs = 15_000, redirectsLeft = 3): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : undefined;
    if (!mod) {
      reject(new Error(`Unsupported URL protocol '${parsed.protocol}'.`));
      return;
    }

    const req = mod.get(
      parsed,
      {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'PerplexiCode-CatalogUpdater/4.0',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
          const nextUrl = new URL(res.headers.location, parsed).toString();
          res.resume();
          fetchBytes(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} fetching ${urlStr}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > 10 * 1024 * 1024) {
            req.destroy(new Error('Remote model catalog exceeds 10 MB safety limit.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${urlStr}`)));
  });
}

export interface RemoteCatalogUpdateOptions {
  catalogUrl?: string;
  sha256Url?: string;
  cacheDir?: string;
  timeoutMs?: number;
  fetchBytesFn?: (url: string, timeoutMs?: number) => Promise<Buffer>;
}

export interface RemoteCatalogUpdateResult {
  updated: boolean;
  usedFallback: boolean;
  sha256?: string;
  snapshotDate?: string;
  modelCount: number;
  models: ModelInfo[];
  error?: string;
}

/**
 * Loads a previously downloaded & SHA-256 verified catalog from disk cache if valid.
 * Re-verifies the SHA-256 digest on disk read; if tampered or missing, keeps bundled fallback active.
 */
export function loadCachedVerifiedModelCatalog(cacheDir?: string): RemoteCatalogUpdateResult {
  const file = defaultCacheFile(cacheDir);
  if (!fs.existsSync(file)) {
    const fallback = getFallbackModelCatalog();
    return {
      updated: false,
      usedFallback: true,
      modelCount: fallback.length,
      models: fallback,
    };
  }

  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      sha256?: string;
      rawJson?: string;
    };
    if (typeof cached.sha256 !== 'string' || typeof cached.rawJson !== 'string') {
      throw new CatalogVerificationError('Cached model catalog missing sha256 or rawJson.');
    }
    const verified = verifyAndParseRemoteCatalog(Buffer.from(cached.rawJson, 'utf8'), cached.sha256);
    setVerifiedRemoteModelsConfig({
      config: verified.config,
      snapshotDate: verified.snapshotDate,
      sha256: verified.sha256,
    });
    const catalog = getFallbackModelCatalog();
    return {
      updated: true,
      usedFallback: false,
      sha256: verified.sha256,
      snapshotDate: verified.snapshotDate,
      modelCount: catalog.length,
      models: catalog,
    };
  } catch (err) {
    setVerifiedRemoteModelsConfig(undefined);
    const fallback = getFallbackModelCatalog();
    return {
      updated: false,
      usedFallback: true,
      modelCount: fallback.length,
      models: fallback,
      error: (err as Error).message,
    };
  }
}

/**
 * Downloads the repository model catalog JSON and its SHA-256 checksum, verifies integrity and
 * schema, persists to cache (`0600`), and activates it in memory. On any network, checksum, or
 * schema failure, preserves the built-in `bundledModelsConfig.json` snapshot as fallback.
 */
export async function updateModelCatalogFromRepository(
  options: RemoteCatalogUpdateOptions = {}
): Promise<RemoteCatalogUpdateResult> {
  const catalogUrl = options.catalogUrl || process.env.PCODE_REMOTE_CATALOG_URL || DEFAULT_REMOTE_CATALOG_URL;
  const sha256Url =
    options.sha256Url || process.env.PCODE_REMOTE_CATALOG_SHA256_URL || `${catalogUrl}.sha256`;
  const downloader = options.fetchBytesFn || fetchBytes;

  try {
    const [rawJsonBytes, rawShaBytes] = await Promise.all([
      downloader(catalogUrl, options.timeoutMs),
      downloader(sha256Url, options.timeoutMs),
    ]);

    const verified = verifyAndParseRemoteCatalog(rawJsonBytes, rawShaBytes.toString('utf8'));
    const cacheFile = defaultCacheFile(options.cacheDir);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      cacheFile,
      JSON.stringify(
        {
          sha256: verified.sha256,
          snapshotDate: verified.snapshotDate,
          sourceUrl: catalogUrl,
          fetchedAt: new Date().toISOString(),
          rawJson: rawJsonBytes.toString('utf8'),
        },
        null,
        2
      ),
      { encoding: 'utf8', mode: 0o600 }
    );

    setVerifiedRemoteModelsConfig({
      config: verified.config,
      snapshotDate: verified.snapshotDate,
      sha256: verified.sha256,
    });
    const catalog = getFallbackModelCatalog();
    return {
      updated: true,
      usedFallback: false,
      sha256: verified.sha256,
      snapshotDate: verified.snapshotDate,
      modelCount: catalog.length,
      models: catalog,
    };
  } catch (err) {
    // Keep existing verified state or pure bundled snapshot untouched
    const fallback = getFallbackModelCatalog();
    return {
      updated: false,
      usedFallback: true,
      modelCount: fallback.length,
      models: fallback,
      error: (err as Error).message || String(err),
    };
  }
}
