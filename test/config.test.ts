import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against the classic monorepo drift bug: `tsconfig.base.json` paths and
 * the Vite alias map are two hand-maintained lists that must stay identical.
 * If someone adds a package to one and forgets the other, this test fails.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const read = (relative: string): string => readFileSync(`${repoRoot}${relative}`, 'utf8');

/** Parses `'key': here('relative/path')` pairs out of the Vite config. */
function parseViteAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const regex = /'([^']+)':\s*here\('([^']+)'\)/g;
  for (const match of source.matchAll(regex)) {
    aliases.set(match[1] as string, match[2] as string);
  }
  return aliases;
}

describe('workspace wiring', () => {
  const tsconfig = JSON.parse(read('tsconfig.base.json')) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const tsPaths = tsconfig.compilerOptions.paths;

  const viteConfig = read('apps/client/vite.config.ts');
  const viteAliases = parseViteAliases(viteConfig);

  it('declares the same workspace aliases in tsconfig and in Vite', () => {
    expect([...viteAliases.keys()].sort()).toEqual(Object.keys(tsPaths).sort());
  });

  it('points every alias at the same source file', () => {
    for (const [key, targets] of Object.entries(tsPaths)) {
      expect(viteAliases.get(key)).toBe(`../../${targets[0]}`);
    }
  });

  it('only aliases source files that actually exist', () => {
    for (const target of viteAliases.values()) {
      // Alias targets are written relative to apps/client/vite.config.ts.
      expect(existsSync(`${repoRoot}${target.slice(6)}`)).toBe(true);
    }
  });

  it('anchors every Vite alias so a package name cannot swallow its subpaths', () => {
    // Vite's string aliases are *prefix* matches, so a plain '@coc/game-data'
    // key also captures '@coc/game-data/version' and resolves it to
    // '…/src/index.ts/version'. The config therefore builds anchored RegExps.
    const viteConfig = read('apps/client/vite.config.ts');
    expect(viteConfig).toContain('new RegExp');
    // The raw record must never be handed to `alias` directly: string keys are
    // prefix matches, which is the bug this guards against.
    expect(viteConfig).not.toMatch(/alias:\s*workspaceAliases/);
    expect(viteConfig).toContain('alias: aliasEntries');

    // The pattern source must be anchored at both ends...
    const pattern = /find:\s*new RegExp\(`([^`]+)`\)/.exec(viteConfig);
    expect(pattern).not.toBeNull();
    const source = pattern?.[1] as string;
    expect(source.startsWith('^')).toBe(true);
    expect(source.endsWith('$')).toBe(true);

    // ...and it must be derived from the alias key rather than hard-coded, so a
    // new package cannot be added without being anchored too.
    expect(source).toContain('${key.replace(');
    expect(source).toContain('[.*+?^${}()|[\\]\\\\]');

    // Re-derive the same anchored pattern the config builds and prove it behaves:
    // it matches the key exactly and refuses the key plus any subpath.
    const escape = (key: string): string => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const key of viteAliases.keys()) {
      const pattern = new RegExp(`^${escape(key)}$`);
      expect(pattern.test(key), `${key} should match its own alias`).toBe(true);
      expect(pattern.test(`${key}/version`), `${key} must not swallow subpaths`).toBe(false);
      expect(pattern.test(`${key}x`), `${key} must not match longer names`).toBe(false);
    }

    // Prove the anchoring is load-bearing: the unanchored form really does
    // swallow the '/version' subpath that broke the client build in Phase 1.
    expect(new RegExp('@coc/game-data').test('@coc/game-data/version')).toBe(true);
    expect(new RegExp('^@coc/game-data$').test('@coc/game-data/version')).toBe(false);
  });

  it('exposes a dependency-free version subpath so the client bundle stays lean', () => {
    const versionModule = read('packages/game-data/src/version.ts');
    expect(versionModule).not.toContain('@coc/sim-core');
    expect(versionModule).not.toContain('zod');
  });

  it('keeps the workspace layout from the design spec', () => {
    const workspace = read('pnpm-workspace.yaml');
    expect(workspace).toContain("'packages/*'");
    expect(workspace).toContain("'apps/*'");
  });
});
