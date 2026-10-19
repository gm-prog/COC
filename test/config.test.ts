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

describe('workspace wiring', () => {
  const tsconfig = JSON.parse(read('tsconfig.base.json')) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const tsPaths = tsconfig.compilerOptions.paths;

  const viteConfig = read('apps/client/vite.config.ts');
  const aliasRegex =
    /'(@coc\/[a-z-]+)':\s*here\('\.\.\/\.\.\/(packages\/[a-z-]+\/src\/index\.ts)'\)/g;
  const viteAliases = new Map<string, string>();
  for (const match of viteConfig.matchAll(aliasRegex)) {
    // Alias targets are written relative to apps/client/vite.config.ts.
    viteAliases.set(match[1], `../../${match[2]}`);
  }

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
      expect(existsSync(`${repoRoot}${target.slice(6)}`)).toBe(true);
    }
  });

  it('keeps the workspace layout from the design spec', () => {
    const workspace = read('pnpm-workspace.yaml');
    expect(workspace).toContain("'packages/*'");
    expect(workspace).toContain("'apps/*'");
  });
});
