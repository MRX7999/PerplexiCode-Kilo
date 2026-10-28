/** Inline SVG icons (stroke-based, 16px grid) so the webview needs no icon font. */

const svg = (body: string, extra = '') =>
  `<svg class="icon" ${extra} viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons: Record<string, string> = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  history: svg('<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.6h2.6"/><path d="M8 5v3.2l2.2 1.4"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>'),
  external: svg('<path d="M9 2.5h4.5V7"/><path d="M13.5 2.5 7.5 8.5"/><path d="M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7"/>'),
  send: svg('<path d="M2.5 8 13.5 2.5 10 13.5 7.5 9z"/><path d="M7.5 9 13.5 2.5"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none"/>'),
  sparkle: svg('<path d="M8 2.2 9.2 6.1 13 7.4 9.2 8.7 8 12.6 6.8 8.7 3 7.4 6.8 6.1z"/><path d="M12.6 11.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z"/>'),
  globe: svg('<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.7 1.6 2.6 3.6 2.6 5.8S9.7 12.2 8 13.8C6.3 12.2 5.4 10.2 5.4 8S6.3 3.8 8 2.2z"/>'),
  chevronDown: svg('<path d="m4 6 4 4 4-4"/>'),
  chevronRight: svg('<path d="m6 4 4 4-4 4"/>'),
  chevronLeft: svg('<path d="m10 4-4 4 4 4"/>'),
  check: svg('<path d="m3.5 8.5 3 3 6-7"/>'),
  x: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  file: svg('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>'),
  folder: svg('<path d="M1.8 4.2v8.3h12.4V5.6H7.6L6.2 4.2z"/>'),
  search: svg('<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.4 3.4"/>'),
  terminal: svg('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.2"/><path d="m4.5 6.2 2 1.8-2 1.8M8 10h3.5"/>'),
  edit: svg('<path d="M10.8 2.6 13.4 5.2 6 12.6l-3.2.6.6-3.2z"/>'),
  diff: svg('<path d="M5 2.5v6M2 5.5h6M8 11.5h6"/><rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/>'),
  question: svg('<circle cx="8" cy="8" r="5.8"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4"/><path d="M8 11.4v.1"/>'),
  todo: svg('<path d="M2.5 4l1 1 2-2M2.5 9l1 1 2-2M7.5 4h6M7.5 9h6M7.5 13h6"/>'),
  brain: svg('<path d="M6 2.5a2 2 0 0 0-2 2 2 2 0 0 0-1.5 3.3A2.2 2.2 0 0 0 4 11.5a2 2 0 0 0 2 2h.5V2.5z"/><path d="M10 2.5a2 2 0 0 1 2 2 2 2 0 0 1 1.5 3.3 2.2 2.2 0 0 1-1.5 3.7 2 2 0 0 1-2 2h-.5V2.5z"/>'),
  warning: svg('<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.6v.1"/>'),
  info: svg('<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.7M8 5.1v.1"/>'),
  restore: svg('<path d="M3 8a5 5 0 1 0 1.5-3.6"/><path d="M3 2.8v2.6h2.6"/>'),
  copy: svg('<rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M11 5V3.2a.7.7 0 0 0-.7-.7H3.2a.7.7 0 0 0-.7.7v7.1c0 .4.3.7.7.7H5"/>'),
  trash: svg('<path d="M2.8 4.2h10.4M6.3 4.2V2.6h3.4v1.6M4.2 4.2l.6 9.2h6.4l.6-9.2"/>'),
  export: svg('<path d="M8 10V2.5M5 5.2 8 2.3l3 2.9"/><path d="M3 9.5v4h10v-4"/>'),
  user: svg('<circle cx="8" cy="5.5" r="2.7"/><path d="M2.8 13.6c.7-2.4 2.8-3.8 5.2-3.8s4.5 1.4 5.2 3.8"/>'),
  key: svg('<circle cx="5.2" cy="10.8" r="2.7"/><path d="m7.2 8.8 6-6M11.2 4.8l1.6 1.6"/>'),
  refresh: svg('<path d="M13.2 6.2A5.3 5.3 0 0 0 3.4 4.6M2.8 9.8a5.3 5.3 0 0 0 9.8 1.6"/><path d="M13.4 2.5v3.8H9.6M2.6 13.5V9.7h3.8"/>'),
  code: svg('<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  architect: svg('<path d="M2 13.8 8 2.2l6 11.6"/><path d="M4.4 9.3h7.2"/>'),
  ask: svg('<path d="M2.5 3.2h11v7.6H7.2L4 13.3v-2.5H2.5z"/><path d="M6.6 5.6a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9M8 9.1v.1"/>'),
  debug: svg('<rect x="4.6" y="4.4" width="6.8" height="8.6" rx="3.4"/><path d="M8 4.4V13M2.4 8.6h2.2M11.4 8.6h2.2M3 4.8l1.9 1.4M13 4.8l-1.9 1.4M3 12.6l1.9-1.4M13 12.6l-1.9-1.4M6 2.6l.8 1.2M10 2.6l-.8 1.2"/>'),
  orchestrator: svg('<circle cx="8" cy="3.4" r="1.6"/><circle cx="3.4" cy="12.4" r="1.6"/><circle cx="12.6" cy="12.4" r="1.6"/><path d="M8 5v3M8 8 4.4 11M8 8l3.6 3"/>'),
  review: svg('<path d="M1.8 8s2.3-4.6 6.2-4.6S14.2 8 14.2 8 11.9 12.6 8 12.6 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/>'),
  subtask: svg('<path d="M3 2.5v6.5a2 2 0 0 0 2 2h8"/><path d="m10.5 8.5 2.5 2.5-2.5 2.5"/>'),
  checkpoint: svg('<circle cx="8" cy="8" r="2.3"/><path d="M1.5 8h4.2M10.3 8h4.2"/>'),
  completion: svg('<circle cx="8" cy="8" r="5.8"/><path d="m5.3 8.2 1.9 1.9 3.6-4"/>'),
  api: svg('<path d="M2.5 8h3l1.5-3.5 2 7 1.5-3.5h3"/>'),
  account: svg('<circle cx="8" cy="8" r="5.8"/><circle cx="8" cy="6.6" r="1.9"/><path d="M4.4 12.3c.8-1.4 2.1-2.1 3.6-2.1s2.8.7 3.6 2.1"/>'),
  spinner: '<span class="spinner" aria-hidden="true"></span>',
  dot: svg('<circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none"/>'),
  insert: svg('<path d="M8 2.5v7M5 6.8 8 9.8l3-3"/><path d="M2.5 13.5h11"/>'),
  more: svg('<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>'),
  at: svg('<circle cx="8" cy="8" r="2.4"/><path d="M10.4 8v1.1a1.6 1.6 0 0 0 3.2 0V8A5.6 5.6 0 1 0 11 12.8"/>'),
  slash: svg('<path d="M10.5 2.5 5.5 13.5"/>'),
};

/** Provider logos approximated with simple shapes (the picker in the Perplexity app uses brand marks). */
export const providerIcons: Record<string, string> = {
  PERPLEXITY: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><rect x="6" y="6" width="4" height="4" rx=".6"/><path d="M6 1.8v1.7M10 1.8v1.7M6 12.5v1.7M10 12.5v1.7M1.8 6h1.7M1.8 10h1.7M12.5 6h1.7M12.5 10h1.7"/>'),
  SONAR: svg('<circle cx="8" cy="8" r="1.6"/><path d="M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10"/>'),
  OPENAI: svg('<path d="M8 1.9c1.6 0 2.9 1.1 3.2 2.6 1.4.4 2.4 1.7 2.4 3.2 0 .9-.4 1.8-1 2.4.2 1.8-1.2 3.6-3.1 3.6-.6 0-1.1-.1-1.5-.4-.4.3-.9.4-1.5.4-1.9 0-3.3-1.8-3.1-3.6-.6-.6-1-1.5-1-2.4 0-1.5 1-2.8 2.4-3.2.3-1.5 1.6-2.6 3.2-2.6z"/><path d="M8 5.3 10.4 6.7v2.6L8 10.7 5.6 9.3V6.7z"/>'),
  GOOGLE: svg('<path d="M8 1.5c.5 3.6 2.9 6 6.5 6.5-3.6.5-6 2.9-6.5 6.5-.5-3.6-2.9-6-6.5-6.5 3.6-.5 6-2.9 6.5-6.5z" fill="currentColor" stroke="none"/>'),
  ANTHROPIC: svg('<path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2M5.5 2l5 12M10.5 2l-5 12M2 5.5l12 5M14 5.5l-12 5" stroke-width="1"/>'),
  MOONSHOT_AI: svg('<path d="M3.5 2.5v11M3.5 8.5 10 2.5M6 6.4l5 7.1" stroke-width="1.8"/><circle cx="12.6" cy="3.6" r="1" fill="currentColor" stroke="none"/>'),
  ZAI: svg('<path d="M3 3h10L3 13h10" stroke-width="1.8"/><path d="M6.5 8h4" stroke-width="1.8"/>'),
  XAI: svg('<circle cx="8" cy="8" r="4.6"/><path d="M13.5 2.5 2.5 13.5" stroke-width="1.6"/>'),
  NVIDIA: svg('<path d="M1.5 8.2C3.4 5 6 4 8.8 4.2c2.1.1 4 .9 5.7 2.3v5.3c-1.6 1-3.5 1.5-5.6 1.4C6 13 3.5 11.5 1.5 8.2z"/><path d="M5 8.2c1-1.4 2.2-2 3.6-1.9 1 .1 1.8.6 2.4 1.4-.6.9-1.5 1.5-2.6 1.6-1.4.1-2.5-.3-3.4-1.1z"/>'),
  DEEPSEEK: svg('<path d="M2 8.5c1.5 3.5 5 5 8.5 3.5 2.1-.9 3.5-3 3.5-5.5-1 1-2 1.3-3 1.1C10.2 5 8 3.6 5.5 4 3.4 4.3 2.1 6.1 2 8.5z"/>'),
};

export function providerIcon(provider: string | null | undefined, modelId: string): string {
  if (modelId === 'turbo') {
    return providerIcons.PERPLEXITY;
  }
  return providerIcons[(provider || '').toUpperCase()] || providerIcons.SONAR;
}

export function modeIcon(slug: string): string {
  return icons[slug] || icons.code;
}

/** Brand mark: code chevrons around a four-point spark with an amber accent (matches media/icon.png). */
export const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="pk-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d2a3a"/><stop offset="1" stop-color="#0a4d55"/></linearGradient><linearGradient id="pk-fg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14b8c6"/><stop offset="1" stop-color="#5eead4"/></linearGradient></defs><rect x="0" y="0" width="64" height="64" rx="15" fill="url(#pk-bg)"/><path d="M22 20 L11 32 L22 44" fill="none" stroke="url(#pk-fg)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 20 L53 32 L42 44" fill="none" stroke="url(#pk-fg)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 18 C33 27 35 30 43 32 C35 34 33 37 32 46 C31 37 29 34 21 32 C29 30 31 27 32 18 Z" fill="#e6fffb"/><path d="M44.5 15 L47 17.5 L44.5 20 L42 17.5 Z" fill="#f5b544"/></svg>`;
