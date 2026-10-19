import { t, type TranslationKey } from './i18n';

/**
 * Thin wrapper over the DOM debug HUD (index.html).
 *
 * Keeping the HUD in the DOM rather than in Phaser means crisp scalable text,
 * real accessibility semantics, and something Playwright can assert against in
 * Phase 3. Phase 3 swaps this for the production HUD; the pattern stays.
 */
export class Hud {
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
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
  }

  setHint(): void {
    this.text('hud-hint', t('hud.hint'));
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

  setSelection(
    details: {
      kind: 'building' | 'obstacle';
      id: string;
      x: number;
      y: number;
      level?: number;
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
  }
}
