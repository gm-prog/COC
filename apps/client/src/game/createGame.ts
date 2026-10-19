import Phaser from 'phaser';
import { BootScene } from '../scenes/BootScene';

/**
 * Builds the Phaser game instance.
 *
 * Scale.RESIZE keeps the canvas filling its parent, which is what the browser
 * preview and the mobile web view need; Capacitor gets the same behaviour.
 */
export function createGame(parent: HTMLElement): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#0d1117',
    transparent: false,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.NO_CENTER,
      width: parent.clientWidth || 960,
      height: parent.clientHeight || 540,
    },
    render: {
      antialias: true,
      powerPreference: 'high-performance',
      roundPixels: false,
    },
    scene: [BootScene],
    // Phaser's banner is noise in the console during CI/dev.
    banner: false,
    audio: { noAudio: true },
  });
}
