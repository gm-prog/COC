# THIRD_PARTY.md

Ledger of third-party libraries and fonts, with licences (design spec §4).
Keep this in sync with `pnpm-lock.yaml`; CI does not check it, humans do.

## Runtime dependencies

| Package   | Version | Used by       | Licence |
| --------- | ------- | ------------- | ------- |
| `phaser`  | ^3.90.0 | `@coc/client` | MIT     |
| `fastify` | ^5.12.7 | `@coc/server` | MIT     |

## Build / dev tooling

| Package                  | Version  | Used by                     | Licence    |
| ------------------------ | -------- | --------------------------- | ---------- |
| `typescript`             | ^5.9.3   | all                         | Apache-2.0 |
| `vite`                   | ^7.3.7   | `@coc/client`               | MIT        |
| `tsx`                    | ^4.23.15 | `@coc/server`, `@coc/tools` | MIT        |
| `vitest`                 | ^3.2.7   | all                         | MIT        |
| `eslint`                 | ^9.39.5  | all                         | MIT        |
| `@eslint/js`             | ^9.39.5  | all                         | MIT        |
| `typescript-eslint`      | ^8.71.2  | all                         | MIT        |
| `eslint-config-prettier` | ^10.1.8  | all                         | MIT        |
| `prettier`               | ^3.9.10  | all                         | MIT        |
| `@types/node`            | ^22.15.0 | server, tools               | MIT        |

Licences were checked against each package's published metadata on 2026-10-19.
MIT/Apache-2.0 are compatible with commercial use; no copyleft dependency is
permitted in this project without a written review.

## Fonts

None yet — the client uses system UI fonts.

## Re-verify before launch

- Re-run a licence/notice audit (Phase 15 dependency audit).
- Confirm the Capacitor and any store SDK licences.
