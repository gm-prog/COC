import { expect, test, type Page } from '@playwright/test';
import { collectBrowserErrors } from './support/browserErrors';
import { canvasBox, tileCenterToPage, type Tile } from './support/villageGeometry';

/**
 * Phase 3 browser test: obstacle removal (Gate C item 10).
 *
 * The journey is driven through visible controls: select the starter rock, read
 * its panel, press **Remove**, read the reward the game says it paid, wait for
 * the save indicator, reload, and confirm the rock is still gone and the
 * resources came back.
 *
 * ## The scenario, against the real starter data
 *
 * `starter.json` puts a rock at (6, 20) — a 1×1 obstacle inside the buildable
 * core, numbered 5. The starter sits at the Keep's 1,000 Gold cap and holds 50
 * Gems. A rock is configured as `{ gold: 30, gems: 1 }`, and §7.2 makes
 * overflow lossy while Gems are uncapped, so removing it must leave Gold at
 * 1,000, raise Gems to 51, and report that the Gold was lost — never that 30
 * Gold was paid.
 *
 * (6, 20) lands at (192, 64) on the 1280×800 canvas: inside the viewport, below
 * the status row and clear of every interactive HUD panel. `test/e2e-contract`
 * re-derives that point from the same helpers and asserts it stays that way.
 */

/** Fixed wall clock for the first scenario. */
const START_TIME = new Date('2026-01-01T00:00:00.000Z');

/** `starter.json`: rock 5, at (6, 20). */
const ROCK_TILE: Tile = { x: 6, y: 20 };

/** The Keep is 4×4 at (18, 18); this tile is its centre and clear of the HUD. */
const KEEP_TILE: Tile = { x: 19, y: 19 };

/** Simulated time that covers the autosave debounce (400 ms) with margin. */
const SAVE_DEBOUNCE_MS = 1_000;
/** One frame's worth of simulated time, enough for Phaser to process input. */
const FRAME_MS = 120;

/** Pins the clock a little ahead of now, absorbing round-trip latency. */
async function freezeClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 2_000));
}

/** One burst of frames so Phaser dispatches queued pointer events. */
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

/** Taps the tile using the shared geometry helper. */
async function tapTile(page: Page, tile: Tile): Promise<void> {
  await tapCanvas(page, tileCenterToPage(await canvasBox(page), tile));
}

test('a rock can be cleared for its Gem reward, and the loss is reported honestly', async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await page.goto('/');

  // 1. A fresh village at the starter's caps: 1,000 Gold, 50 Gems.
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#resource-gems-value')).toHaveText('50');
  await freezeClock(page);

  // 2. The starter save commits before anything else, so the removal is the
  //    only write in play.
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-save-state', 'saved');

  // 3. Select the rock at (6, 20).
  await tapTile(page, ROCK_TILE);
  await expect(page.getByTestId('selection-panel')).toBeVisible();
  await expect(page.locator('#selection-kind')).toHaveText('Obstacle');
  await expect(page.locator('#selection-title')).toHaveText('Rock');
  await expect(page.locator('#selection-meta')).toHaveText('Tile 6, 20');

  // 4. The panel offers Remove, names the rock, and previews the configured
  //    reward without promising it: the capacity warning is there because Gold
  //    is capped.
  const removeButton = page.getByTestId('selection-remove');
  await expect(removeButton).toBeVisible();
  await expect(removeButton).toBeEnabled();
  await expect(removeButton).toHaveText('Remove');
  await expect(removeButton).toHaveAccessibleName('Remove Rock');
  await expect(page.locator('#selection-reward')).toHaveText(
    'Reward: 30 Gold · 1 Gems · overflow is lost when storage is full',
  );
  // Obstacles are not buildings: Move must not be offered for one.
  await expect(page.getByTestId('selection-move')).toBeHidden();

  // 5. Remove it.
  await removeButton.click();

  // 6. The rock is gone: the panel closed and tapping its tile selects nothing.
  await expect(page.getByTestId('selection-panel')).toBeHidden();
  await tapTile(page, ROCK_TILE);
  await expect(page.getByTestId('selection-panel')).toBeHidden();

  // 7. Gold stays at the cap — the 30 Gold did not fit — while the uncapped Gem
  //    is credited.
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#resource-gems-value')).toHaveText('51');

  // 8. The feedback reports what was actually credited and lost, never the
  //    full configured reward as received.
  const hint = page.getByTestId('hint');
  await expect(hint).toHaveText('Rock cleared: 1 Gems; 30 Gold was lost to storage.');

  // 9. Wait for the transaction to commit (`saved` only comes from `oncomplete`).
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-save-state', 'saved');

  // 10. Reload: the rock stays gone and the resources come back.
  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#resource-gems-value')).toHaveText('51');

  await tapTile(page, ROCK_TILE);
  await expect(page.getByTestId('selection-panel')).toBeHidden();

  browserErrors.expectNone('the obstacle removal and reload journey');
});

test('the Remove action is not attached to buildings', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await page.goto('/');

  await expect(page.locator('#game canvas')).toBeVisible();
  await freezeClock(page);

  // Select the Keep, a building with a full complement of building actions.
  await tapTile(page, KEEP_TILE);
  await expect(page.getByTestId('selection-panel')).toBeVisible();
  await expect(page.locator('#selection-kind')).toHaveText('Building');
  await expect(page.locator('#selection-title')).toHaveText('Keep');
  await expect(page.locator('#selection-meta')).toContainText('Level 1 · Tile 18, 18');

  // No obstacle action, and no obstacle reward preview.
  await expect(page.getByTestId('selection-remove')).toBeHidden();
  await expect(page.locator('#selection-reward')).toBeHidden();

  // The building's own actions keep working.
  await expect(page.getByTestId('selection-move')).toBeVisible();
  await expect(page.getByTestId('selection-move')).toHaveAccessibleName('Move Keep');
  await expect(page.locator('#selection-upgrade-title')).toBeVisible();

  // Selecting an obstacle swaps the actions rather than adding to them: the
  // building actions disappear, so the two can never both apply.
  await tapTile(page, ROCK_TILE);
  await expect(page.locator('#selection-title')).toHaveText('Rock');
  await expect(page.getByTestId('selection-move')).toBeHidden();
  await expect(page.locator('#selection-collect')).toBeHidden();
  await expect(page.locator('#selection-upgrade')).toBeHidden();
  await expect(page.getByTestId('selection-remove')).toBeVisible();

  browserErrors.expectNone('switching selection between a building and an obstacle');
});

test('removal is refused in a read-only session and nothing is written', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  // No fake clock here: this scenario is about the device clock disagreeing
  // with the save, so the page runs on real time.
  await page.goto('/');
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gems-value')).toHaveText('50');

  // Let the starter village commit, then move its watermark an hour ahead. The
  // record stays a valid v2 save; only the clock disagrees with it, which is
  // exactly what a player with a slow device clock looks like.
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-save-state', 'saved');
  const rewritten = await page.evaluate(async () => {
    const open = (): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('emberhold');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await open();
    try {
      const record = await new Promise<{ state: { lastSyncAt: number } }>((resolve, reject) => {
        const tx = db.transaction('village', 'readwrite');
        const store = tx.objectStore('village');
        const get = store.get('current');
        get.onsuccess = () => {
          const value = get.result as { state: { lastSyncAt: number } };
          value.state.lastSyncAt = Date.now() + 3_600_000;
          store.put(value, 'current');
          resolve(value);
        };
        get.onerror = () => reject(get.error);
      });
      return record.state.lastSyncAt;
    } finally {
      db.close();
    }
  });
  expect(rewritten).toBeGreaterThan(0);

  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible();
  // The session knows it must not write, and says why.
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-save-state', 'clock_behind');

  // The obstacle is still selectable — viewing is allowed — but removing it is
  // refused with the session's own explanation.
  await tapTile(page, ROCK_TILE);
  await expect(page.getByTestId('selection-panel')).toBeVisible();
  await expect(page.locator('#selection-title')).toHaveText('Rock');
  const removeButton = page.getByTestId('selection-remove');
  await expect(removeButton).toBeVisible();
  await removeButton.click();

  await expect(page.getByTestId('hint')).toHaveText(
    "Read-only: correct this device's clock, then reload, to keep playing.",
  );
  // Nothing changed: the obstacle is still selected and the village untouched.
  await expect(page.locator('#selection-title')).toHaveText('Rock');
  await expect(page.locator('#resource-gems-value')).toHaveText('50');
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');

  // And nothing was written: a reload shows the rock and the same resources.
  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gems-value')).toHaveText('50');
  await tapTile(page, ROCK_TILE);
  await expect(page.locator('#selection-title')).toHaveText('Rock');

  browserErrors.expectNone('the read-only obstacle removal attempt');
});
