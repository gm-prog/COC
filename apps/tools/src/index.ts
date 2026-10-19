import { CONFIG_VERSION, RESOURCE_IDS } from '@coc/game-data';
import { PROTOCOL_VERSION } from '@coc/protocol';
import { GRID, SIM_CORE_VERSION } from '@coc/sim-core';

/**
 * Developer CLI.
 *
 * Phase 0 ships a single `info` command so the tools workspace is runnable and
 * so sim-core is exercised from a third consumer (client, server, tools).
 * `sim:run`, the base editor and the balance simulator land in Phase 5/16.
 */

const COMMANDS = ['info', 'help'] as const;
type Command = (typeof COMMANDS)[number];

function printInfo(): void {
  const rows: [string, string][] = [
    ['sim-core', SIM_CORE_VERSION],
    ['game-data (config)', CONFIG_VERSION],
    ['protocol', PROTOCOL_VERSION],
    ['map size', `${GRID.total} x ${GRID.total} tiles`],
    ['buildable area', `${GRID.buildable} x ${GRID.buildable} tiles`],
    ['decorative margin', `${GRID.margin} tiles`],
    ['resources', RESOURCE_IDS.join(', ')],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(width)}  ${value}\n`);
  }
}

function printHelp(): void {
  process.stdout.write(`Emberhold developer tools\n\nUsage: tools <command>\n\nCommands:\n`);
  for (const command of COMMANDS) {
    process.stdout.write(`  ${command}\n`);
  }
}

function main(argv: string[]): number {
  const command = (argv[0] ?? 'info') as Command;

  switch (command) {
    case 'info':
      printInfo();
      return 0;
    case 'help':
      printHelp();
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}". Try: tools help\n`);
      return 1;
  }
}

process.exit(main(process.argv.slice(2)));
