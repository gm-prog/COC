import { describe, expect, it } from 'vitest';
import { GRID } from '@coc/sim-core';
import {
  centerOnWorld,
  clampPan,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  screenToWorld,
  worldSizeForGrid,
  worldToScreen,
  zoomAt,
  type CameraTransform,
  type ViewBounds,
} from '../src/cameraTransform';
import { TILE_HEIGHT, TILE_WIDTH } from '../src/iso';

const world = worldSizeForGrid(GRID.total, TILE_WIDTH, TILE_HEIGHT);

/** A typical phone/desktop viewport: the map is much larger than the screen. */
const bounds: ViewBounds = {
  viewWidth: 960,
  viewHeight: 540,
  worldWidth: world.worldWidth, // 3072
  worldHeight: world.worldHeight, // 1536
};

/**
 * A viewport far smaller than the map, so the map overflows it at every zoom
 * level and the pan clamp never engages: the zoom anchor stays exact.
 * (Needs viewWidth < worldWidth * MIN_ZOOM and viewHeight < worldHeight * MIN_ZOOM,
 * with enough slack that the anchor point stays inside the allowed pan range.)
 */
const roomy: ViewBounds = {
  viewWidth: 320,
  viewHeight: 160,
  worldWidth: world.worldWidth,
  worldHeight: world.worldHeight,
};

const at = (zoom: number, panX: number, panY: number): CameraTransform => ({ zoom, panX, panY });

describe('camera transform', () => {
  it('derives the projected world size from the grid and tile size', () => {
    expect(world).toEqual({ worldWidth: 48 * 64, worldHeight: 48 * 32 });
  });

  it('clamps zoom into the configured range', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });

  it('round-trips world and screen coordinates', () => {
    const transform = at(1.4, 320, -180);
    const screen = worldToScreen(transform, 12, 34);
    const back = screenToWorld(transform, screen.x, screen.y);
    expect(back.x).toBeCloseTo(12, 9);
    expect(back.y).toBeCloseTo(34, 9);
  });

  it('centres the world in a viewport big enough to hold it', () => {
    const centred = centerOnWorld(roomy);
    const middle = worldToScreen(centred, 0, world.worldHeight / 2);
    expect(middle.x).toBeCloseTo(roomy.viewWidth / 2);
    expect(middle.y).toBeCloseTo(roomy.viewHeight / 2);
  });

  it('never lets the map leave the viewport while panning', () => {
    let transform = centerOnWorld(bounds);
    for (let i = 0; i < 200; i += 1) {
      transform = panBy(transform, -137, 91, bounds);
      const topLeft = worldToScreen(transform, -world.worldWidth / 2, 0);
      const bottomRight = worldToScreen(transform, world.worldWidth / 2, world.worldHeight);
      expect(topLeft.x).toBeLessThanOrEqual(0.001);
      expect(bottomRight.x).toBeGreaterThanOrEqual(bounds.viewWidth - 0.001);
      expect(topLeft.y).toBeLessThanOrEqual(0.001);
      expect(bottomRight.y).toBeGreaterThanOrEqual(bounds.viewHeight - 0.001);
    }
  });

  it('clamps panning all the way down as well as all the way up', () => {
    let transform = centerOnWorld(bounds);
    for (let i = 0; i < 200; i += 1) {
      transform = panBy(transform, 61, -53, bounds);
      const topLeft = worldToScreen(transform, -world.worldWidth / 2, 0);
      const bottomRight = worldToScreen(transform, world.worldWidth / 2, world.worldHeight);
      expect(topLeft.x).toBeLessThanOrEqual(0.001);
      expect(bottomRight.x).toBeGreaterThanOrEqual(bounds.viewWidth - 0.001);
      expect(topLeft.y).toBeLessThanOrEqual(0.001);
      expect(bottomRight.y).toBeGreaterThanOrEqual(bounds.viewHeight - 0.001);
    }
  });

  it('keeps the world point under the cursor fixed while zooming', () => {
    let transform = centerOnWorld(roomy);
    const cursor = { x: roomy.viewWidth * 0.7, y: roomy.viewHeight * 0.25 };

    for (const factor of [1.2, 1.2, 0.5, 3, 0.1]) {
      const before = screenToWorld(transform, cursor.x, cursor.y);
      transform = zoomAt(transform, cursor.x, cursor.y, factor, roomy);
      const after = screenToWorld(transform, cursor.x, cursor.y);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('stops at the zoom limits no matter how much it is asked to zoom', () => {
    let zoomedIn = centerOnWorld(bounds);
    let zoomedOut = centerOnWorld(bounds);
    for (let i = 0; i < 50; i += 1) {
      zoomedIn = zoomAt(zoomedIn, 10, 10, 4, bounds);
      zoomedOut = zoomAt(zoomedOut, 10, 10, 0.01, bounds);
    }
    expect(zoomedIn.zoom).toBe(MAX_ZOOM);
    expect(zoomedOut.zoom).toBe(MIN_ZOOM);
  });

  it('centres the map on an axis when it is smaller than the viewport', () => {
    const small: ViewBounds = { ...bounds, worldWidth: 400, worldHeight: 200 };
    const transform = clampPan(at(1, 9999, -9999), small);
    // World point (0, 100) — the vertical middle of the small map — is centred.
    const middle = worldToScreen(transform, 0, 100);
    expect(middle.x).toBeCloseTo(small.viewWidth / 2);
    expect(middle.y).toBeCloseTo(small.viewHeight / 2);
  });

  it('is a pure function: the input transform is never mutated', () => {
    const original = at(1, 100, 100);
    const snapshot = { ...original };
    clampPan(original, bounds);
    panBy(original, 50, 50, bounds);
    zoomAt(original, 0, 0, 2, bounds);
    expect(original).toEqual(snapshot);
  });
});
