/**
 * Browser-error recorder for the smoke test.
 *
 * The Phase 3 acceptance criteria in `docs/GAME_SPEC.md` end with "no console
 * errors", so the test fails when the page throws or logs an error. Exceptions
 * inside Phaser's animation loop never surface as a failed assertion otherwise —
 * the game simply stops drawing — so `pageerror` is the important one.
 */

import { expect, type Page } from '@playwright/test';

export interface BrowserErrors {
  /** Everything recorded so far, oldest first. */
  messages(): string[];
  /** Fails the test if anything unexpected was recorded. */
  expectNone(context: string): void;
}

/**
 * Chromium requests `/favicon.ico` for any page that does not declare one, and
 * the Vite dev server has no favicon to serve. That 404 is noise from the
 * browser, not from the game, so it is filtered out by URL.
 */
function isExpectedNoise(text: string, url: string): boolean {
  return url.endsWith('/favicon.ico') || text.includes('/favicon.ico');
}

/** Starts recording `pageerror` and `console.error` for the rest of the test. */
export function collectBrowserErrors(page: Page): BrowserErrors {
  const recorded: string[] = [];

  page.on('pageerror', (error) => {
    recorded.push(`uncaught exception: ${error.message}`);
  });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const url = message.location().url;
    if (isExpectedNoise(text, url)) return;
    recorded.push(url === '' ? `console.error: ${text}` : `console.error: ${text} (${url})`);
  });

  return {
    messages: () => [...recorded],
    expectNone: (context: string) => {
      expect(recorded, `${context} produced browser errors:\n${recorded.join('\n')}`).toEqual([]);
    },
  };
}
