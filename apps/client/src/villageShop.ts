import {
  canAfford,
  countBuildings,
  type GameConfig,
  type PlayerState,
  type ResourceAmount,
  type BuildingSize,
} from '@coc/sim-core';

export type ShopUnavailableReason =
  | 'unavailable'
  | 'keep_level'
  | 'limit'
  | 'no_builder'
  | 'resources';

export interface BuildingShopItem {
  id: string;
  size: BuildingSize;
  cost: ResourceAmount;
  buildSeconds: number;
  reason: ShopUnavailableReason | null;
  requiredKeep: number;
  count: number;
  limit?: number;
}

/**
 * Builds shop presentation data from the same balance tables and player state
 * used by sim-core. Placement is still validated by applyCommand at commit time.
 */
export function listBuildingShopItems(
  state: PlayerState,
  config: GameConfig,
): BuildingShopItem[] {
  return config.buildings.map((definition): BuildingShopItem => {
    const levelOne = definition.levels.find((level) => level.level === 1);
    const count = countBuildings(state, definition.id);
    const limits = config.limits.buildingCounts[definition.id];
    const limit =
      limits && limits.length > 0
        ? limits[Math.min(Math.max(state.keepLevel, 0), limits.length - 1)]
        : undefined;

    let reason: ShopUnavailableReason | null = null;
    if (levelOne === undefined) {
      reason = 'unavailable';
    } else if (state.keepLevel < definition.unlock.keepLevel) {
      reason = 'keep_level';
    } else if (limit !== undefined && count >= limit) {
      reason = 'limit';
    } else if (state.builders.busy.length >= state.builders.count) {
      reason = 'no_builder';
    } else if (!canAfford(state, levelOne.cost).ok) {
      reason = 'resources';
    }

    return {
      id: definition.id,
      size: definition.size,
      cost: levelOne?.cost ?? {},
      buildSeconds: levelOne?.buildSeconds ?? 0,
      reason,
      requiredKeep: definition.unlock.keepLevel,
      count,
      ...(limit !== undefined ? { limit } : {}),
    };
  });
}
