import { t, type TranslationKey } from './i18n';
import {
  formatRemainingDuration,
  type VillageHudSnapshot,
} from './villageHud';
import type { BuildingShopItem } from './villageShop';
import type { BuildingLevel, ResourceId } from '@coc/sim-core';
import type { BuildingUpgradeSnapshot } from './villageUpgrade';
import type { SaveProblemCode } from './persistence/villageSave';
import type { SaveStatus } from './persistence/autosave';

/**
 * Everything the save indicator can show.
 *
 * The first four are the live autosave status; the rest are the reasons saving
 * is switched off for this session.
 */
export type SaveIndicator =
  | SaveStatus
  | 'unavailable'
  | 'unreadable'
  | 'incompatible'
  | 'clock_behind';

/** Translation key for each indicator state. */
const SAVE_INDICATOR_KEYS: Record<SaveIndicator, TranslationKey> = {
  idle: 'save.saved',
  saving: 'save.saving',
  saved: 'save.saved',
  blocked: 'save.blocked',
  unavailable: 'save.unavailable',
  unreadable: 'save.unreadable',
  incompatible: 'save.incompatible',
  clock_behind: 'save.clockBehind',
};

/**
 * Maps a load problem to the indicator that explains it.
 *
 * Exported so the scene does not have to know which codes mean "no store" and
 * which mean "there is a record we refused to touch".
 */
export function saveIndicatorForProblem(problem: SaveProblemCode): SaveIndicator {
  switch (problem) {
    case 'storage_unavailable':
      return 'unavailable';
    case 'incompatible_config':
      return 'incompatible';
    case 'malformed':
    case 'unsupported_schema':
      return 'unreadable';
    case 'clock_behind':
      return 'clock_behind';
  }
}

/**
 * Thin wrapper over the DOM debug HUD (index.html).
 *
 * Keeping the HUD in the DOM rather than in Phaser means crisp scalable text,
 * real accessibility semantics, and something Playwright can assert against in
 * Phase 3. Phase 3 swaps this for the production HUD; the pattern stays.
 */
export class Hud {
  private readonly root: HTMLElement;
  private onSelectBuilding: ((buildingType: string) => void) | null = null;
  private onCancelPlacement: (() => void) | null = null;
  private onCollectResource: ((buildingId: number) => void) | null = null;
  private onStartUpgrade: ((buildingId: number) => void) | null = null;

  private readonly handleHudClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const actionElement = event.target.closest<HTMLElement>('[data-hud-action]');
    if (!actionElement || !this.root.contains(actionElement)) return;

    const action = actionElement.dataset.hudAction;
    if (action === 'toggle-shop') {
      this.setShopOpen(!this.isShopOpen());
    } else if (action === 'close-shop') {
      this.setShopOpen(false);
    } else if (action === 'select-building') {
      const buildingType = actionElement.dataset.buildingType;
      if (buildingType) {
        this.setShopOpen(false);
        this.onSelectBuilding?.(buildingType);
      }
    } else if (action === 'cancel-placement') {
      this.onCancelPlacement?.();
    } else if (action === 'collect-resource') {
      const buildingId = Number(actionElement.dataset.buildingId);
      if (Number.isInteger(buildingId) && buildingId > 0) {
        this.onCollectResource?.(buildingId);
      }
    } else if (action === 'start-upgrade') {
      const buildingId = Number(actionElement.dataset.buildingId);
      if (Number.isInteger(buildingId) && buildingId > 0) {
        this.onStartUpgrade?.(buildingId);
      }
    }
  };

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.addEventListener('click', this.handleHudClick);
  }

  dispose(): void {
    this.root.removeEventListener('click', this.handleHudClick);
  }

  setShopHandlers(handlers: {
    onSelectBuilding: (buildingType: string) => void;
    onCancelPlacement: () => void;
    onCollectResource: (buildingId: number) => void;
    onStartUpgrade: (buildingId: number) => void;
  }): void {
    this.onSelectBuilding = handlers.onSelectBuilding;
    this.onCancelPlacement = handlers.onCancelPlacement;
    this.onCollectResource = handlers.onCollectResource;
    this.onStartUpgrade = handlers.onStartUpgrade;
  }

  isShopOpen(): boolean {
    const panel = this.el('shop-panel');
    return panel !== null && !panel.hidden;
  }

  setShopOpen(open: boolean): void {
    const panel = this.el('shop-panel');
    if (panel) panel.hidden = !open;
    this.el('shop-toggle')?.setAttribute('aria-expanded', String(open));
  }

  setShopCatalog(items: BuildingShopItem[]): void {
    const container = this.el('shop-items');
    if (!container) return;
    container.replaceChildren();

    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'shop-item';
      card.dataset.testid = 'shop-item-' + item.id;

      const heading = document.createElement('div');
      heading.className = 'shop-item__heading';
      const title = document.createElement('strong');
      title.textContent = t(('building.' + item.id) as TranslationKey);
      const size = document.createElement('span');
      size.textContent = t('shop.size', { width: item.size.w, height: item.size.h });
      heading.append(title, size);

      const costParts = Object.entries(item.cost)
        .filter((entry): entry is [string, number] => entry[1] !== undefined && entry[1] > 0)
        .map((entry) => entry[1] + ' ' + t(('resource.' + entry[0]) as TranslationKey));
      const cost = costParts.length > 0 ? costParts.join(' · ') : t('shop.free');
      const duration =
        item.buildSeconds === 0
          ? t('shop.instant')
          : t('shop.seconds', { seconds: item.buildSeconds });
      const details = document.createElement('p');
      details.className = 'shop-item__details';
      details.textContent = t('shop.details', { cost, duration });

      const reason = document.createElement('p');
      reason.className = 'shop-item__reason';
      reason.hidden = item.reason === null;
      reason.textContent = this.shopReason(item);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'shop-item__button';
      button.dataset.hudAction = 'select-building';
      button.dataset.buildingType = item.id;
      button.disabled = item.reason !== null;
      button.textContent = t('shop.select');
      button.setAttribute(
        'aria-label',
        t('shop.selectNamed', { building: title.textContent ?? item.id }),
      );

      card.append(heading, details, reason, button);
      container.append(card);
    }
  }

  private shopReason(item: BuildingShopItem): string {
    switch (item.reason) {
      case 'keep_level':
        return t('shop.requiredKeep', { level: item.requiredKeep });
      case 'limit':
        return t('shop.limitReached', {
          count: item.count,
          limit: item.limit ?? item.count,
        });
      case 'no_builder':
        return t('shop.buildersBusy');
      case 'resources':
        return t('shop.insufficient');
      case 'unavailable':
        return t('shop.unavailable');
      default:
        return '';
    }
  }

  setPlacementMode(buildingType: string | null): void {
    const banner = this.el('placement-banner');
    if (!banner) return;
    banner.hidden = buildingType === null;
    this.text('hud-hint', buildingType === null ? t('hud.hint') : '');
    if (buildingType !== null) {
      const buildingKey = 'building.' + buildingType;
      const building = t(buildingKey as TranslationKey);
      this.text('placement-title', t('placement.title', { building }));
      this.setPlacementFeedback('none');
    }
  }

  setPlacementFeedback(state: 'none' | 'valid' | 'invalid' | 'outside'): void {
    const banner = this.el('placement-banner');
    if (banner) {
      banner.classList.remove('placement-banner--valid', 'placement-banner--invalid');
      if (state === 'valid') banner.classList.add('placement-banner--valid');
      if (state === 'invalid') banner.classList.add('placement-banner--invalid');
    }
    const key = {
      none: 'placement.instructions',
      valid: 'placement.valid',
      invalid: 'placement.invalid',
      outside: 'placement.outside',
    }[state] as TranslationKey;
    this.text('placement-feedback', t(key));
  }

  private el(id: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`#${id}`);
  }

  private text(id: string, value: string): void {
    const node = this.el(id);
    if (node) node.textContent = value;
  }

  setTitle(): void {
    this.text('hud-title', t('app.title'));
    this.root.setAttribute('aria-label', t('app.hudAriaLabel'));
    this.text('label-fps', t('hud.fps'));
    this.text('label-zoom', t('hud.zoom'));
    this.text('label-tile', t('hud.tile'));
    this.text('label-zone', t('hud.zone'));
    this.text('shop-toggle', t('shop.title'));
    this.text('shop-title', t('shop.title'));
    this.text('shop-description', t('shop.description'));
    this.text('placement-cancel', t('placement.cancel'));
    this.el('shop-close')?.setAttribute('aria-label', t('shop.close'));
  }

  /**
   * Sets the hint line.
   *
   * Defaults to the standing hint; a caller that just refused an action passes
   * the reason so the refusal is explained where the player is looking.
   */
  setHint(key: TranslationKey = 'hud.hint'): void {
    this.text('hud-hint', t(key));
  }

  setFps(fps: number): void {
    this.text('hud-fps', fps > 0 ? String(Math.round(fps)) : t('hud.tileNone'));
  }

  setZoom(zoom: number): void {
    this.text('hud-zoom', `${Math.round(zoom * 100)}%`);
  }

  setTile(tileX: number, tileY: number): void {
    this.text('hud-tile', `${tileX}, ${tileY}`);
  }

  clearTile(): void {
    this.text('hud-tile', t('hud.tileNone'));
  }

  setZone(buildable: boolean): void {
    this.text('hud-zone', buildable ? t('hud.zoneBuildable') : t('hud.zoneMargin'));
  }

  clearZone(): void {
    this.text('hud-zone', t('hud.tileNone'));
  }

  setVersions(versions: { protocol: string; simCore: string; config: string }): void {
    this.text('hud-versions', t('hud.versions', versions));
  }

  /**
   * Shows the persistence indicator.
   *
   * `idle` hides it: a brand-new session with nothing worth saving should not
   * announce anything. Every other state is real information, so it stays on
   * screen rather than flashing past.
   *
   * Called only when the state actually changes (see `VillageAutosave`), so this
   * never runs once per frame.
   */
  setSaveIndicator(state: SaveIndicator): void {
    const node = this.el('save-status');
    if (!node) return;
    node.dataset.saveState = state;
    if (state === 'idle') {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.textContent = t(SAVE_INDICATOR_KEYS[state]);
    node.hidden = false;
  }

  setVillageSnapshot(snapshot: VillageHudSnapshot): void {
    this.el('village-hud')?.setAttribute('aria-label', t('village.status'));
    this.el('village-hud-resources')?.setAttribute('aria-label', t('village.resources'));
    this.el('builder-card')?.setAttribute('aria-label', t('builders.title'));

    for (const resource of snapshot.resources) {
      const prefix = 'resource-' + resource.id;
      const label = t(('resource.' + resource.id) as TranslationKey);
      this.text(prefix + '-label', label);
      this.text(
        prefix + '-value',
        resource.capacity === undefined
          ? t('resource.amount', { amount: resource.amount })
          : t('resource.amountCapacity', {
              amount: resource.amount,
              capacity: resource.capacity,
            }),
      );

      const track = this.el(prefix + '-track');
      const fill = this.el(prefix + '-fill');
      if (!track || !fill) continue;

      const capacity = resource.capacity;
      const hasCapacity = capacity !== undefined && capacity > 0;
      track.hidden = !hasCapacity;
      fill.style.width =
        hasCapacity && capacity !== undefined
          ? Math.min(100, Math.max(0, (resource.amount / capacity) * 100)) + '%'
          : '0%';

      if (hasCapacity && capacity !== undefined) {
        track.setAttribute('aria-label', t('resource.storageLabel', { resource: label }));
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', String(capacity));
        track.setAttribute('aria-valuenow', String(Math.min(resource.amount, capacity)));
      }
    }

    this.text('builders-title', t('builders.title'));
    this.text(
      'builders-count',
      t('builders.available', {
        available: snapshot.builders.available,
        total: snapshot.builders.total,
      }),
    );

    const indicators = this.el('builder-indicators');
    if (indicators) {
      indicators.setAttribute('aria-label', t('builders.status'));
      indicators.replaceChildren();
      for (let index = 0; index < snapshot.builders.total; index += 1) {
        const busy = index >= snapshot.builders.available;
        const icon = document.createElement('span');
        icon.className = busy ? 'builder-icon builder-icon--busy' : 'builder-icon';
        icon.textContent = '⚒';
        icon.setAttribute('role', 'img');
        icon.setAttribute(
          'aria-label',
          busy
            ? t('builders.busyIcon', { number: index + 1 })
            : t('builders.availableIcon', { number: index + 1 }),
        );
        indicators.append(icon);
      }
    }

    const countdowns = this.el('builder-countdowns');
    if (countdowns) {
      countdowns.replaceChildren();
      countdowns.hidden = snapshot.builders.busy.length === 0;
      for (const builder of snapshot.builders.busy) {
        const item = document.createElement('li');
        const knownLabels: Record<string, TranslationKey> = {
          keep: 'building.keep',
          gold_mine: 'building.gold_mine',
          essence_well: 'building.essence_well',
          gold_store: 'building.gold_store',
          essence_store: 'building.essence_store',
          wall: 'building.wall',
        };
        const labelKey = knownLabels[builder.buildingType];
        const building = labelKey ? t(labelKey) : t('builders.unknownBuilding');
        item.textContent = t('builders.busyItem', {
          building,
          remaining: formatRemainingDuration(builder.remainingMs),
        });
        countdowns.append(item);
      }
    }
  }

  setSelection(
    details: {
      kind: 'building' | 'obstacle';
      id: string;
      x: number;
      y: number;
      level?: number;
      entityId?: number;
      collection?: { resource: ResourceId; amount: number };
      upgrade?: BuildingUpgradeSnapshot;
    } | null,
  ): void {
    const panel = this.el('selection-panel');
    if (!panel) return;

    if (!details) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    this.text(
      'selection-kind',
      t(details.kind === 'building' ? 'selection.kind.building' : 'selection.kind.obstacle'),
    );
    this.text('selection-title', t(`${details.kind}.${details.id}` as TranslationKey));
    this.text(
      'selection-meta',
      details.kind === 'building' && details.level !== undefined
        ? t('selection.meta.building', {
            level: details.level,
            x: details.x,
            y: details.y,
          })
        : t('selection.meta.obstacle', { x: details.x, y: details.y }),
    );

    const buffer = this.el('selection-buffer');
    const collectButton = this.el('selection-collect') as HTMLButtonElement | null;
    const collection = details.kind === 'building' ? details.collection : undefined;
    if (buffer) {
      buffer.hidden = collection === undefined;
      buffer.textContent = collection
        ? t('selection.buffer', {
            amount: collection.amount,
            resource: t(('resource.' + collection.resource) as TranslationKey),
          })
        : '';
    }
    if (collectButton) {
      collectButton.hidden = collection === undefined;
      collectButton.disabled = collection === undefined || collection.amount <= 0;
      if (collection && details.entityId !== undefined) {
        const resourceName = t(('resource.' + collection.resource) as TranslationKey);
        collectButton.dataset.buildingId = String(details.entityId);
        collectButton.textContent = t('selection.collect');
        collectButton.setAttribute(
          'aria-label',
          t('selection.collectNamed', { amount: collection.amount, resource: resourceName }),
        );
      } else {
        delete collectButton.dataset.buildingId;
      }
    }

    this.setUpgradePanel(
      details.kind === 'building' ? details.upgrade : undefined,
      details.entityId,
    );
  }

  private setUpgradePanel(snapshot: BuildingUpgradeSnapshot | undefined, buildingId?: number): void {
    const panel = this.el('selection-upgrade');
    const title = this.el('selection-upgrade-title');
    const cost = this.el('selection-upgrade-cost');
    const stats = this.el('selection-upgrade-stats');
    const status = this.el('selection-upgrade-status');
    const button = this.el('selection-upgrade-button') as HTMLButtonElement | null;
    if (!panel || !title || !cost || !stats || !status || !button) return;

    if (!snapshot || snapshot.kind === 'missing') {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    button.hidden = true;
    button.disabled = true;
    delete button.dataset.buildingId;
    cost.textContent = '';
    stats.textContent = '';

    if (snapshot.kind === 'max_level') {
      title.textContent = t('upgrade.maxLevel');
      status.textContent = t('upgrade.maxLevel');
      return;
    }

    if (snapshot.kind === 'in_progress') {
      title.textContent = t('upgrade.inProgress', { level: snapshot.targetLevel });
      cost.textContent = t('upgrade.remaining', {
        duration: formatRemainingDuration(snapshot.remainingMs),
      });
      stats.textContent = snapshot.target ? this.formatUpgradeStats(snapshot.target) : '';
      status.textContent = t('upgrade.working');
      return;
    }

    title.textContent = t('upgrade.nextLevel', { level: snapshot.target.level });
    cost.textContent = t('upgrade.costAndTime', {
      cost: this.formatUpgradeResources(snapshot.target.cost),
      duration: formatRemainingDuration(snapshot.durationMs),
    });
    stats.textContent = this.formatUpgradeStats(snapshot.target);

    if (snapshot.kind === 'available') {
      status.textContent = t('upgrade.available');
      button.hidden = false;
      button.disabled = false;
    } else {
      status.textContent = this.upgradeBlockReason(snapshot);
      button.hidden = false;
      button.disabled = true;
    }

    if (buildingId !== undefined) {
      button.dataset.buildingId = String(buildingId);
      button.setAttribute(
        'aria-label',
        t('upgrade.startNamed', { level: snapshot.target.level }),
      );
    }
    button.textContent = t('upgrade.start');
  }

  private upgradeBlockReason(
    snapshot: Extract<BuildingUpgradeSnapshot, { kind: 'blocked' }>,
  ): string {
    switch (snapshot.reason) {
      case 'keep_level_too_low':
        return t('upgrade.keepLevel', { level: snapshot.requiredKeep });
      case 'insufficient_resources':
        return t('upgrade.insufficient');
      case 'no_builder':
        return t('upgrade.buildersBusy');
      case 'already_upgrading':
        return t('upgrade.alreadyUpgrading');
      default:
        return t('upgrade.unavailable');
    }
  }

  private formatUpgradeResources(resources: object): string {
    const parts = Object.entries(resources)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
      .map((entry) => entry[1] + ' ' + t(('resource.' + entry[0]) as TranslationKey));
    return parts.length > 0 ? parts.join(' · ') : t('shop.free');
  }

  private formatUpgradeStats(target: BuildingLevel): string {
    const parts = [t('upgrade.hp', { amount: target.hp })];
    if (target.produces && target.productionPerHour !== undefined) {
      parts.push(
        t('upgrade.production', {
          amount: target.productionPerHour,
          resource: t(('resource.' + target.produces) as TranslationKey),
        }),
      );
    }
    if (target.storageCap) {
      parts.push(t('upgrade.storage', { amount: this.formatUpgradeResources(target.storageCap) }));
    }
    if (target.bufferCap !== undefined) {
      parts.push(t('upgrade.buffer', { amount: target.bufferCap }));
    }
    if (target.housing !== undefined) parts.push(t('upgrade.housing', { amount: target.housing }));
    if (target.queueSlots !== undefined) {
      parts.push(t('upgrade.queueSlots', { amount: target.queueSlots }));
    }
    if (target.dps !== undefined) parts.push(t('upgrade.dps', { amount: target.dps }));
    return parts.join(' · ');
  }
}
