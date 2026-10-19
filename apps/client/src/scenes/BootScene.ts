import Phaser from 'phaser';
import { GAME_CONFIG } from '@coc/game-data';
import { CONFIG_VERSION } from '@coc/game-data/version';
import { PROTOCOL_VERSION } from '@coc/protocol';
import {
  createNewPlayerState,
  GRID,
  SIM_CORE_VERSION,
  type BuildingCategory,
  type PlayerState,
} from '@coc/sim-core';
import {
  centerOnWorld,
  clampPan,
  panBy,
  screenToWorld,
  zoomAt,
  worldSizeForGrid,
  type CameraTransform,
  type ViewBounds,
} from '../cameraTransform';
import { Hud } from '../hud';
import {
  findVillageEntityAtTile,
  listVillageEntities,
  type VillageEntity,
} from '../villageLayout';
import {
  screenToTileFloor,
  tileCenterToScreen,
  tileRectToScreenQuad,
  tileToScreen,
  TILE_HEIGHT,
  TILE_WIDTH,
} from '../iso';

/** Multiplier applied per wheel/pinch/keyboard zoom notch. */
const ZOOM_STEP = 1.12;

/** Screen-space size of the whole map at zoom 1 (see `iso.ts`). */
const WORLD = worldSizeForGrid(GRID.total, TILE_WIDTH, TILE_HEIGHT);

const COLORS = {
  backdrop: 0x151c2b,
  buildable: 0x24304a,
  gridLine: 0x3c4c6d,
  border: 0x6f86ad,
  origin: 0xf0a33c,
  hoverFill: 0xf0a33c,
  hoverLine: 0xffd79a,
  selectLine: 0x57d98a,
  marginLine: 0x8a5a2b,
};

interface EntityStyle {
  top: number;
  left: number;
  right: number;
  height: number;
}

const BUILDING_STYLES: Record<BuildingCategory, EntityStyle> = {
  hq: { top: 0xf6c76d, left: 0x99602e, right: 0xc58b3f, height: 24 },
  economy: { top: 0x78ca8a, left: 0x326b48, right: 0x4b9a64, height: 14 },
  storage: { top: 0x79bce5, left: 0x315c80, right: 0x427eaa, height: 15 },
  army: { top: 0xc3a0e8, left: 0x69478a, right: 0x8964ad, height: 16 },
  defense: { top: 0xe58b82, left: 0x8a3e3a, right: 0xb6554d, height: 17 },
  trap: { top: 0xd0a16b, left: 0x78502d, right: 0xa46d3c, height: 5 },
  wall: { top: 0xb5bdc9, left: 0x626d7c, right: 0x8792a1, height: 7 },
  misc: { top: 0xc1c7d0, left: 0x626975, right: 0x858c98, height: 10 },
};

const OBSTACLE_STYLES: Record<string, EntityStyle> = {
  tree: { top: 0x78b66c, left: 0x345a38, right: 0x4e8248, height: 12 },
  rock: { top: 0xb4bdc9, left: 0x596371, right: 0x7d8796, height: 5 },
};

const FALLBACK_OBSTACLE_STYLE: EntityStyle = {
  top: 0xb4bdc9,
  left: 0x596371,
  right: 0x7d8796,
  height: 6,
};

interface Tile {
  x: number;
  y: number;
}

/**
 * Phase 0 boot scene: renders the 48x48 map as an isometric grid and proves
 * out camera pan/zoom (mouse, wheel, touch, pinch) plus tile picking.
 *
 * No game rules live here — it only draws what sim-core describes.
 */
export class BootScene extends Phaser.Scene {
  static readonly KEY = 'Boot';

  private hud!: Hud;
  private world!: Phaser.GameObjects.Container;
  private staticLayer!: Phaser.GameObjects.Graphics;
  private entityLayer!: Phaser.GameObjects.Graphics;
  private hoverLayer!: Phaser.GameObjects.Graphics;
  private selectLayer!: Phaser.GameObjects.Graphics;

  private playerState!: PlayerState;
  private selectedEntity: VillageEntity | null = null;
  private transform: CameraTransform = { zoom: 1, panX: 0, panY: 0 };

  private panPointerId = -1;
  private panLastX = 0;
  private panLastY = 0;
  private panDistance = Number.POSITIVE_INFINITY;
  private panStartedAt = 0;
  private lastPinchDistance = 0;

  private hoverTile: Tile | null = null;
  private selectedTile: Tile | null = null;

  private fpsElapsed = 0;
  private fpsFrames = 0;

  constructor() {
    super({ key: BootScene.KEY });
  }

  create(): void {
    const hudRoot = document.getElementById('hud');
    this.hud = new Hud(hudRoot ?? document.body);
    this.hud.setTitle();
    this.hud.setHint();
    this.hud.setVersions({
      protocol: PROTOCOL_VERSION,
      simCore: SIM_CORE_VERSION,
      config: CONFIG_VERSION,
    });

    this.world = this.add.container(0, 0);
    this.staticLayer = this.add.graphics();
    this.entityLayer = this.add.graphics();
    this.selectLayer = this.add.graphics();
    this.hoverLayer = this.add.graphics();
    this.world.add([this.staticLayer, this.entityLayer, this.selectLayer, this.hoverLayer]);

    this.playerState = createNewPlayerState(GAME_CONFIG, 0);
    this.drawStaticGrid();
    this.drawVillageEntities();

    this.recenter();

    this.setupInput();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.teardownInput, this);
  }

  // ---------------------------------------------------------------- rendering

  private drawStaticGrid(): void {
    const g = this.staticLayer;
    g.clear();

    g.fillStyle(COLORS.backdrop, 1);
    g.fillPoints(tileRectToScreenQuad(0, 0, GRID.total, GRID.total), true);

    g.fillStyle(COLORS.buildable, 1);
    const buildable = tileRectToScreenQuad(
      GRID.margin,
      GRID.margin,
      GRID.buildable,
      GRID.buildable,
    );
    g.fillPoints(buildable, true);

    g.lineStyle(1, COLORS.gridLine, 0.55);
    for (let i = 0; i <= GRID.total; i += 1) {
      const verticalA = tileToScreen(i, 0);
      const verticalB = tileToScreen(i, GRID.total);
      g.lineBetween(verticalA.x, verticalA.y, verticalB.x, verticalB.y);

      const horizontalA = tileToScreen(0, i);
      const horizontalB = tileToScreen(GRID.total, i);
      g.lineBetween(horizontalA.x, horizontalA.y, horizontalB.x, horizontalB.y);
    }

    g.lineStyle(2, COLORS.border, 0.9);
    g.strokePoints(buildable, true);

    g.lineStyle(1, COLORS.marginLine, 0.5);
    g.strokePoints(tileRectToScreenQuad(0, 0, GRID.total, GRID.total), true);

    const origin = tileCenterToScreen(GRID.margin, GRID.margin);
    g.fillStyle(COLORS.origin, 1);
    g.fillCircle(origin.x, origin.y, 5);
    g.fillStyle(COLORS.origin, 0.35);
    g.fillCircle(origin.x, origin.y, 12);
  }

  /** Draws simple, data-driven placeholder blocks from the starter state. */
  private drawVillageEntities(): void {
    this.entityLayer.clear();
    for (const entity of listVillageEntities(this.playerState, GAME_CONFIG)) {
      this.drawEntityBlock(entity);
    }
  }

  private drawEntityBlock(entity: VillageEntity): void {
    const instance = entity.instance;
    const size = entity.definition.size;
    const style =
      entity.kind === 'building'
        ? BUILDING_STYLES[entity.definition.category]
        : (OBSTACLE_STYLES[entity.definition.id] ?? FALLBACK_OBSTACLE_STYLE);

    const base = tileRectToScreenQuad(instance.x, instance.y, size.w, size.h);
    const top = base.map((point) => ({ x: point.x, y: point.y - style.height }));
    const b1 = base[1]!;
    const b2 = base[2]!;
    const b3 = base[3]!;
    const t0 = top[0]!;
    const t1 = top[1]!;
    const t2 = top[2]!;
    const t3 = top[3]!;
    const g = this.entityLayer;

    // A subtle ground footprint anchors each raised block to its tiles.
    g.fillStyle(0x080c12, 0.28);
    g.fillPoints(base, true);

    g.fillStyle(style.left, 1);
    g.fillPoints([b3, b2, t2, t3], true);
    g.fillStyle(style.right, 1);
    g.fillPoints([b1, b2, t2, t1], true);
    g.fillStyle(style.top, 1);
    g.fillPoints(top, true);
    g.lineStyle(1, 0x0d1117, 0.85);
    g.strokePoints(top, true);
    g.lineStyle(1, 0xffffff, 0.18);
    g.lineBetween(t0.x, t0.y, t1.x, t1.y);
  }

  private drawTileOverlay(
    g: Phaser.GameObjects.Graphics,
    tile: Tile,
    fill: number,
    fillAlpha: number,
    lineColor: number,
    lineWidth: number,
  ): void {
    const quad = tileRectToScreenQuad(tile.x, tile.y, 1, 1);
    if (fillAlpha > 0) {
      g.fillStyle(fill, fillAlpha);
      g.fillPoints(quad, true);
    }
    g.lineStyle(lineWidth, lineColor, 1);
    g.strokePoints(quad, true);
  }

  private redrawHover(): void {
    this.hoverLayer.clear();
    if (this.hoverTile) {
      this.drawTileOverlay(
        this.hoverLayer,
        this.hoverTile,
        COLORS.hoverFill,
        0.18,
        COLORS.hoverLine,
        2,
      );
    }
  }

  private redrawSelection(): void {
    this.selectLayer.clear();
    if (this.selectedEntity) {
      const instance = this.selectedEntity.instance;
      const size = this.selectedEntity.definition.size;
      const footprint = tileRectToScreenQuad(instance.x, instance.y, size.w, size.h);
      this.selectLayer.lineStyle(3, COLORS.selectLine, 1);
      this.selectLayer.strokePoints(footprint, true);
      return;
    }
    if (this.selectedTile) {
      this.drawTileOverlay(this.selectLayer, this.selectedTile, 0x000000, 0, COLORS.selectLine, 3);
    }
  }

  // ------------------------------------------------------------- transforms

  /** Viewport size expressed in the same terms the pure camera maths expects. */
  private get bounds(): ViewBounds {
    return {
      viewWidth: this.scale.width,
      viewHeight: this.scale.height,
      worldWidth: WORLD.worldWidth,
      worldHeight: WORLD.worldHeight,
    };
  }

  private applyTransform(): void {
    this.world.setScale(this.transform.zoom);
    this.world.setPosition(this.transform.panX, this.transform.panY);
    this.hud.setZoom(this.transform.zoom);
  }

  private recenter(): void {
    this.transform = centerOnWorld(this.bounds);
    this.applyTransform();
  }

  /** Zooms while keeping the world point under (screenX, screenY) stationary. */
  private zoomAtScreen(screenX: number, screenY: number, factor: number): void {
    this.transform = zoomAt(this.transform, screenX, screenY, factor, this.bounds);
    this.applyTransform();
  }

  private panByScreen(dx: number, dy: number): void {
    this.transform = panBy(this.transform, dx, dy, this.bounds);
    this.applyTransform();
  }

  // ------------------------------------------------------------------ input

  private setupInput(): void {
    // Allow a third pointer so pinch + a stray touch never breaks input.
    this.input.addPointer(2);

    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.on('pointerupoutside', this.onPointerUp, this);
    this.input.on('wheel', this.onWheel, this);

    this.input.keyboard?.on('keydown', this.onKeyDown, this);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
  }

  private teardownInput(): void {
    this.input.off('pointerdown', this.onPointerDown, this);
    this.input.off('pointermove', this.onPointerMove, this);
    this.input.off('pointerup', this.onPointerUp, this);
    this.input.off('pointerupoutside', this.onPointerUp, this);
    this.input.off('wheel', this.onWheel, this);
    this.input.keyboard?.off('keydown', this.onKeyDown, this);
    this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.panPointerId === -1) {
      this.panPointerId = pointer.id;
      this.panLastX = pointer.x;
      this.panLastY = pointer.y;
      this.panDistance = 0;
      this.panStartedAt = this.time.now;
    }
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const p1 = this.input.pointer1;
    const p2 = this.input.pointer2;

    if (p1.isDown && p2.isDown) {
      const distance = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
      if (this.lastPinchDistance > 0 && distance > 0) {
        this.zoomAtScreen((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, distance / this.lastPinchDistance);
      }
      this.lastPinchDistance = distance;
      this.panPointerId = -1;
      return;
    }

    if (this.panPointerId === -1 && pointer.isDown) {
      this.panPointerId = pointer.id;
      this.panLastX = pointer.x;
      this.panLastY = pointer.y;
      this.panDistance = Number.POSITIVE_INFINITY;
    }

    if (pointer.id === this.panPointerId && pointer.isDown) {
      const dx = pointer.x - this.panLastX;
      const dy = pointer.y - this.panLastY;
      this.panLastX = pointer.x;
      this.panLastY = pointer.y;
      this.panDistance += Math.hypot(dx, dy);
      this.panByScreen(dx, dy);
    }

    this.updateHover(pointer);
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (!(this.input.pointer1.isDown && this.input.pointer2.isDown)) {
      this.lastPinchDistance = 0;
    }

    if (this.panPointerId === pointer.id) {
      const isTap = this.panDistance < 8 && this.time.now - this.panStartedAt < 600;
      this.panPointerId = -1;
      if (isTap) this.selectTileAt(pointer);
    }
  }

  private onWheel(
    pointer: Phaser.Input.Pointer,
    _over: Phaser.GameObjects.GameObject[],
    _dx: number,
    dy: number,
  ): void {
    this.zoomAtScreen(pointer.x, pointer.y, dy > 0 ? 1 / ZOOM_STEP : ZOOM_STEP);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const panStep = 48;
    switch (event.key) {
      case '+':
      case '=':
        this.zoomAtScreen(this.scale.width / 2, this.scale.height / 2, ZOOM_STEP);
        break;
      case '-':
      case '_':
        this.zoomAtScreen(this.scale.width / 2, this.scale.height / 2, 1 / ZOOM_STEP);
        break;
      case '0':
        this.recenter();
        break;
      case 'ArrowLeft':
        this.panByScreen(panStep, 0);
        break;
      case 'ArrowRight':
        this.panByScreen(-panStep, 0);
        break;
      case 'ArrowUp':
        this.panByScreen(0, panStep);
        break;
      case 'ArrowDown':
        this.panByScreen(0, -panStep);
        break;
      default:
        break;
    }
    if (event.key.startsWith('Arrow') || event.key === '+' || event.key === '-') {
      event.preventDefault();
    }
  }

  private onResize(): void {
    this.transform = clampPan(this.transform, this.bounds);
    this.applyTransform();
    this.redrawHover();
  }

  // ------------------------------------------------------------ tile picking

  /** Converts a screen-space pointer position into world (unzoomed) space. */
  private pointerToWorld(pointer: Phaser.Input.Pointer): { x: number; y: number } {
    return screenToWorld(this.transform, pointer.x, pointer.y);
  }

  private isInsideMap(tile: Tile): boolean {
    return tile.x >= 0 && tile.y >= 0 && tile.x < GRID.total && tile.y < GRID.total;
  }

  private updateHover(pointer: Phaser.Input.Pointer): void {
    const world = this.pointerToWorld(pointer);
    const tile = screenToTileFloor(world.x, world.y);
    if (!this.isInsideMap(tile)) {
      if (this.hoverTile !== null) {
        this.hoverTile = null;
        this.redrawHover();
        this.hud.clearTile();
        this.hud.clearZone();
      }
      return;
    }
    const changed = !this.hoverTile || this.hoverTile.x !== tile.x || this.hoverTile.y !== tile.y;
    this.hoverTile = tile;
    if (changed) {
      this.redrawHover();
      this.hud.setTile(tile.x, tile.y);
      this.hud.setZone(this.isBuildable(tile));
    }
  }

  private isBuildable(tile: Tile): boolean {
    return (
      tile.x >= GRID.margin &&
      tile.y >= GRID.margin &&
      tile.x < GRID.margin + GRID.buildable &&
      tile.y < GRID.margin + GRID.buildable
    );
  }

  private selectTileAt(pointer: Phaser.Input.Pointer): void {
    const world = this.pointerToWorld(pointer);
    const tile = screenToTileFloor(world.x, world.y);
    if (!this.isInsideMap(tile)) {
      this.selectedTile = null;
      this.selectedEntity = null;
      this.redrawSelection();
      this.hud.clearTile();
      this.hud.clearZone();
      this.hud.setSelection(null);
      return;
    }

    this.selectedEntity = findVillageEntityAtTile(
      this.playerState,
      GAME_CONFIG,
      tile.x,
      tile.y,
    );
    this.selectedTile = this.selectedEntity ? null : tile;
    this.redrawSelection();
    this.hud.setTile(tile.x, tile.y);
    this.hud.setZone(this.isBuildable(tile));
    const entity = this.selectedEntity;
    if (entity?.kind === 'building') {
      this.hud.setSelection({
        kind: 'building',
        id: entity.definition.id,
        x: entity.instance.x,
        y: entity.instance.y,
        level: entity.instance.level,
      });
    } else if (entity?.kind === 'obstacle') {
      this.hud.setSelection({
        kind: 'obstacle',
        id: entity.definition.id,
        x: entity.instance.x,
        y: entity.instance.y,
      });
    } else {
      this.hud.setSelection(null);
    }
  }

  // ----------------------------------------------------------------- update

  override update(_time: number, delta: number): void {
    this.fpsElapsed += delta;
    this.fpsFrames += 1;
    if (this.fpsElapsed >= 250) {
      this.hud.setFps((this.fpsFrames * 1000) / this.fpsElapsed);
      this.fpsElapsed = 0;
      this.fpsFrames = 0;
    }
  }
}
