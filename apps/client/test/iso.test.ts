import { describe, expect, it } from 'vitest';
import {
  screenToTileFloor,
  tileCenterToScreen,
  tileRectToScreenQuad,
  tileToScreen,
  TILE_HEIGHT,
  TILE_WIDTH,
} from '../src/iso';

describe('isometric projection', () => {
  it('uses a 2:1 tile ratio', () => {
    expect(TILE_WIDTH / TILE_HEIGHT).toBe(2);
  });

  it('puts the origin tile at the screen origin', () => {
    expect(tileToScreen(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('moves +x down-right and +y down-left', () => {
    expect(tileToScreen(1, 0)).toEqual({ x: TILE_WIDTH / 2, y: TILE_HEIGHT / 2 });
    expect(tileToScreen(0, 1)).toEqual({ x: -TILE_WIDTH / 2, y: TILE_HEIGHT / 2 });
  });

  it('round-trips screen -> tile for every tile centre in the map', () => {
    for (let y = 0; y < 48; y += 7) {
      for (let x = 0; x < 48; x += 5) {
        const centre = tileCenterToScreen(x, y);
        expect(screenToTileFloor(centre.x, centre.y)).toEqual({ x, y });
      }
    }
  });

  it('keeps points just inside a tile edge within that tile', () => {
    const centre = tileCenterToScreen(10, 20);
    const epsilon = 0.01;
    expect(screenToTileFloor(centre.x - epsilon, centre.y - epsilon)).toEqual({ x: 10, y: 20 });
    expect(screenToTileFloor(centre.x + epsilon, centre.y - epsilon)).toEqual({ x: 10, y: 20 });
    expect(screenToTileFloor(centre.x - epsilon, centre.y + epsilon)).toEqual({ x: 10, y: 20 });
    expect(screenToTileFloor(centre.x + epsilon, centre.y + epsilon)).toEqual({ x: 10, y: 20 });
  });

  it('returns a four-corner quad for a rectangle, in ring order', () => {
    const quad = tileRectToScreenQuad(4, 4, 40, 40);
    expect(quad).toHaveLength(4);
    expect(quad[0]).toEqual(tileToScreen(4, 4));
    expect(quad[1]).toEqual(tileToScreen(44, 4));
    expect(quad[2]).toEqual(tileToScreen(44, 44));
    expect(quad[3]).toEqual(tileToScreen(4, 44));
  });
});
