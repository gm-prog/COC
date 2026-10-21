import { expect, test, type Page } from '@playwright/test';
import { collectBrowserErrors } from './support/browserErrors';
import { canvasBox, tileCenterToPage, type Tile } from './support/villageGeometry';

/**
 * Phase 3 browser smoke test (spec §"PHASE 3 … Tests": *new game → place mine →
 * wait (mock time) → collect → upgrade*).
 *
 * Everything below is driven the way a player drives it: real DOM clicks on the
 * HUD, real mouse events on the Phaser canvas, and time advanced through
 * Playwright's clock. The test never reaches into the running game's state.
 *
 * ## Time
 *
 * `page.clock.install()` replaces `Date`, `performance`, `setTimeout` and
 * `requestAnimationFrame` before the first script runs, so the scene seeds its
 * economy from a reproducible `Date.now()` and Phaser's animation loop is driven
 * by the same fake clock. After `install` the clock runs in real time (so the
 * game animates and input is processed normally); `runFor(ms)` then jumps it
 * forward, firing every timer and animation frame on the way.
 *
 * Between the jumps the test calls `freezeClock()`. That pins the clock at the
 * current instant so no simulated time leaks in while assertions run: the
 * resource numbers below are exact rather than "approximately four".
 */

/** Fixed wall clock for the whole journey. */
const START_TIME = new Date('2026-01-01T00:00:00.000Z');

/**
 * Where the new Gold Mine goes: a 3×3 footprint at (24, 24) — inside the 40×40
 * buildable core and clear of the starter Keep (18–21), gold mine (14, 17) and
 * essence well (23, 17). Its centre also lands clear of every HUD panel.
 */
const PLACEMENT_TILE: Tile = { x: 24, y: 24 };

/** Gold Mine level 1: 20 s build, 150 gold, 240 gold/hour, 600 buffer. */
const CONSTRUCTION_MS = 21_000;
/** Production window. 240 gold/hour for the ~61 s since completion is 4 gold. */
const PRODUCTION_MS = 60_000;
/** Gold Mine level 2: 32 s upgrade, 230 gold. */
const UPGRADE_MS = 33_000;
/** Simulated time consumed by `freezeClock()` while it settles the UI. */
const FREEZE_MARGIN_MS = 2_000;
/** One frame's worth of simulated time, enough for Phaser to process input. */
const FRAME_MS = 120;

/**
 * Pins the clock at "now + a small margin".
 *
 * `pauseAt` fast-forwards to the target and then stops time; the margin absorbs
 * however long the round-trip to the browser took, so the target is never in the
 * past.
 */
async function freezeClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + FREEZE_MARGIN_MS));
}

/**
 * Advances one short burst of frames. Phaser queues DOM pointer events and
 * dispatches them from its animation loop, so a click made while the clock is
 * paused needs a frame before the game reacts to it.
 */
async function settle(page: Page): Promise<void> {
  await page.clock.runFor(FRAME_MS);
}

/** Hover, press and release across separate frames, as a slow tap would. */
async function tapCanvas(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await settle(page);
  await page.mouse.down();
  await settle(page);
  await page.mouse.up();
  await settle(page);
}

test('a new village can place a Gold Mine, collect its gold and start an upgrade', async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await page.goto('/');

  // 1. A new village: the canvas boots and the starter economy is on screen.
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.getByTestId('versions')).toContainText('sim-core');
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#resource-essence-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#resource-shards-value')).toHaveText('0');
  await expect(page.locator('#resource-gems-value')).toHaveText('50');
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await expect(page.locator('#builder-countdowns')).toBeHidden();
  browserErrors.expectNone('booting a new village');

  await freezeClock(page);

  // 2. Open the build shop and pick a Gold Mine.
  const shopToggle = page.getByRole('button', { name: 'Build', exact: true });
  await expect(shopToggle).toHaveAttribute('aria-expanded', 'false');
  await shopToggle.click();
  await expect(shopToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#shop-panel')).toBeVisible();

  const mineCard = page.getByTestId('shop-item-gold_mine');
  await expect(mineCard).toBeVisible();
  await expect(mineCard).toContainText('Gold Mine');
  await expect(mineCard).toContainText('3×3 tiles');
  await expect(mineCard).toContainText('150 Gold');
  await expect(mineCard).toContainText('20s');

  const chooseMine = mineCard.getByRole('button', { name: 'Choose Gold Mine' });
  await expect(chooseMine).toBeEnabled();
  await chooseMine.click();
  await expect(page.locator('#placement-banner')).toBeVisible();
  await expect(page.locator('#placement-title')).toHaveText('Place Gold Mine');

  // 3. Place it on a valid empty tile, at coordinates derived from the same
  //    geometry helpers the client draws with. The hover assertions prove the
  //    projection against the live game before the click commits anything.
  const point = tileCenterToPage(await canvasBox(page), PLACEMENT_TILE);
  await page.mouse.move(point.x, point.y);
  await settle(page);
  await expect(page.getByTestId('tile')).toHaveText('24, 24');
  await expect(page.getByTestId('zone')).toHaveText('Buildable');
  await expect(page.locator('#placement-feedback')).toHaveText('Valid spot');

  await page.mouse.down();
  await settle(page);
  await page.mouse.up();
  await settle(page);

  await expect(page.locator('#placement-banner')).toBeHidden();
  await expect(page.locator('#resource-gold-value')).toHaveText('850 / 1000'); // 1000 − 150
  await expect(page.locator('#builders-count')).toHaveText('1 / 2 available');
  await expect(page.locator('#builder-countdowns')).toBeVisible();
  await expect(page.locator('#builder-countdowns')).toContainText('Gold Mine');

  // 4. Construction finishes on simulated time alone.
  await page.clock.runFor(CONSTRUCTION_MS);
  await freezeClock(page);
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await expect(page.locator('#builder-countdowns')).toBeHidden();

  // 5. Select the finished mine. It has produced nothing yet, so this opens the
  //    selection panel rather than taking the game's tap-to-collect shortcut.
  await tapCanvas(page, point);
  await expect(page.getByTestId('selection-panel')).toBeVisible();
  await expect(page.locator('#selection-title')).toHaveText('Gold Mine');
  await expect(page.locator('#selection-meta')).toContainText('Level 1');
  await expect(page.locator('#selection-meta')).toContainText('Tile 24, 24');

  const collectButton = page.locator('#selection-collect');
  await expect(collectButton).toBeVisible();
  await expect(collectButton).toBeDisabled();

  // 6. Let the collector fill its buffer.
  await page.clock.runFor(PRODUCTION_MS);
  await freezeClock(page);
  await expect(page.locator('#selection-buffer')).toHaveText('Stored: 4 Gold');
  await expect(collectButton).toBeEnabled();
  await expect(collectButton).toHaveAccessibleName('Collect 4 Gold');
  // Nothing is banked until the player collects it.
  await expect(page.locator('#resource-gold-value')).toHaveText('850 / 1000');

  // 7. Collect through the HUD control.
  await collectButton.click();
  await expect(page.locator('#resource-gold-value')).toHaveText('854 / 1000'); // 850 + 4
  await expect(page.getByTestId('resource-gold-bar')).toHaveAttribute('aria-valuenow', '854');
  await expect(collectButton).toBeDisabled();

  // 8. Start an upgrade: level 2 costs 230 gold and takes 32 s.
  const upgradeStatus = page.locator('#selection-upgrade-status');
  const upgradeButton = page.locator('#selection-upgrade-button');
  await expect(page.locator('#selection-upgrade-title')).toHaveText('Next: level 2');
  await expect(page.locator('#selection-upgrade-cost')).toContainText('Cost: 230 Gold');
  await expect(upgradeStatus).toHaveText('Ready to upgrade');
  await expect(upgradeButton).toBeEnabled();
  await expect(upgradeButton).toHaveAccessibleName('Start upgrade to level 2');

  await upgradeButton.click();
  await expect(page.locator('#resource-gold-value')).toHaveText('624 / 1000'); // 854 − 230
  await expect(page.locator('#builders-count')).toHaveText('1 / 2 available');
  await expect(page.locator('#selection-upgrade-title')).toHaveText('Upgrading to level 2');
  await expect(page.locator('#selection-upgrade-cost')).toHaveText('Time remaining: 32s');
  await expect(upgradeStatus).toHaveText('Your builder is working on this building.');
  await expect(upgradeButton).toBeHidden();

  // 9. The upgrade completes on schedule and the builder is released. The next
  //    level needs Keep 2, so the panel reports the gate rather than a price.
  await page.clock.runFor(UPGRADE_MS);
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await expect(page.locator('#selection-meta')).toContainText('Level 2');
  await expect(page.locator('#selection-upgrade-title')).toHaveText('Next: level 3');
  await expect(upgradeStatus).toHaveText('Requires Keep level 2');

  browserErrors.expectNone('the Phase 3 build → collect → upgrade journey');
});
