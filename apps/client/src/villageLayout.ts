import type {
  BuildingDef,
  BuildingInstance,
  GameConfig,
  ObstacleDef,
  ObstacleInstance,
  PlayerState,
} from '@coc/sim-core';

export type VillageEntity =
  | { kind: 'building'; instance: BuildingInstance; definition: BuildingDef }
  | { kind: 'obstacle'; instance: ObstacleInstance; definition: ObstacleDef };

function entityDepth(entity: VillageEntity): number {
  return (
    entity.instance.x +
    entity.instance.y +
    entity.definition.size.w +
    entity.definition.size.h
  );
}

/**
 * Returns village entities in a stable back-to-front isometric drawing order.
 * Unknown ids are skipped so invalid saved data cannot crash placeholder drawing.
 */
export function listVillageEntities(state: PlayerState, config: GameConfig): VillageEntity[] {
  const entities: VillageEntity[] = [];

  for (const instance of state.obstacles) {
    const definition = config.obstacles.find((candidate) => candidate.id === instance.type);
    if (definition) entities.push({ kind: 'obstacle', instance, definition });
  }

  for (const instance of state.buildings) {
    const definition = config.buildings.find((candidate) => candidate.id === instance.type);
    if (definition) entities.push({ kind: 'building', instance, definition });
  }

  return entities.sort((a, b) => {
    const depthDifference = entityDepth(a) - entityDepth(b);
    if (depthDifference !== 0) return depthDifference;
    if (a.kind !== b.kind) return a.kind === 'obstacle' ? -1 : 1;
    return a.instance.id - b.instance.id;
  });
}

/**
 * Finds the topmost configured entity whose tile footprint contains the click.
 * This uses the same drawing order as rendering, so hit-testing matches what is
 * visible to the player when footprints overlap.
 */
export function findVillageEntityAtTile(
  state: PlayerState,
  config: GameConfig,
  tileX: number,
  tileY: number,
): VillageEntity | null {
  if (!Number.isInteger(tileX) || !Number.isInteger(tileY)) return null;

  const entities = listVillageEntities(state, config);
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const entity = entities[index]!;
    const { x, y } = entity.instance;
    const { w, h } = entity.definition.size;
    if (tileX >= x && tileY >= y && tileX < x + w && tileY < y + h) {
      return entity;
    }
  }

  return null;
}
