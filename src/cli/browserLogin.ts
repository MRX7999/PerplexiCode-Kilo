import * as fs from 'fs';
import * as path from 'path';
import { perplexicodeHome } from '../core/journal';

/** Same browser candidates as the extension's LoginProvider, plus PCODE_BROWSER override. */
export function detectBrowserPath(): string | null {
  const override = process.env.PCODE_BROWSER;
  if (override && fs.existsSync(override)) {
    return override;
  }
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/usr/bin/brave-browser',
    );
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Opens a real browser window (dedicated profile in ~/.perplexicode/browser-profile), waits until
 * the user is logged in to perplexity.ai and returns the session cookies. Nothing is printed.
 */
export async function browserLogin(log: (line: string) => void, timeoutMs = 5 * 60 * 1000): Promise<{ sessionToken: string; csrfToken: string; fullCookies: string } | null> {
  const browserPath = detectBrowserPath();
  if (!browserPath) {
    throw new Error('Chrome / Edge / Brave not found. Set PCODE_BROWSER=/path/to/browser or use `pcode login` and paste the Cookie header.');
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
  const profile = path.join(perplexicodeHome(), 'browser-profile');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: false,
    defaultViewport: null,
    userDataDir: profile,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--window-size=1100,750'],
  });
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.evaluateOnNewDocument(`Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`);
    await page.goto('https://www.perplexity.ai', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
    log('Log in to Perplexity in the opened window. Waiting for the session cookie...');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!browser.connected) return null;
      const cookies = await page.cookies('https://www.perplexity.ai').catch(() => []);
      const session = cookies.find((cookie) => cookie.name === '__Secure-next-auth.session-token');
      if (session?.value) {
        const csrf = cookies.find((cookie) => cookie.name === 'next-auth.csrf-token' || cookie.name === '__Host-next-auth.csrf-token');
        return {
          sessionToken: session.value,
          csrfToken: csrf?.value || '',
          fullCookies: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
