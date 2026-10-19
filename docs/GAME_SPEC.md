EMBERHOLD — Master Build Prompt for a Clash-of-Clans-Style Base-Builder & Raid Game
Version 1.0 · Written 19 Oct 2026 · Working title "Emberhold" (rename freely) Audience: an AI coding agent (and the human directing it). Save this file as docs/GAME_SPEC.md in an empty repo.

0. HOW TO USE THIS FILE
Create an empty Git repo. Save this file as docs/GAME_SPEC.md.
Open your AI coding tool in that repo and paste the Kickoff Prompt from Section 16.
Work one phase at a time (Section 10). For each phase, paste the Phase Prompt Template from Section 16.
After every phase, YOU verify the "Done when" checklist before allowing the next phase. Do not skip this; later phases depend on earlier ones.
Keep two living files in the repo: PROGRESS.md (what is done, what is next) and DECISIONS.md (any deviation from this spec and why).
Realistic scope warning. The real game this genre is modelled on is built and operated by a large studio. This prompt targets a vertical slice → online MVP, in milestones:

Milestone	Phases	You will have
M1 – Offline single-player	0–6	Build a village, collect resources, train an army, raid AI villages
M2 – Online persistent village	7	Accounts, cloud save, server-authoritative economy
M3 – Async PvP MVP	8–9	Raid real players' bases, loot, trophies, shields, replays, tutorial
M4 – Social	10–12	Clans, donations, clan wars, leagues/seasons
M5 – Launch-ready	13–17	Heroes, monetization, anti-cheat, analytics, packaging
Ship M1 and M3 first; they are where the game becomes fun. Everything after is layered on.

1. ROLE AND WORKING AGREEMENT (instructions to the AI agent)
You are a senior game engineer and technical designer. You are building the game described in this file, phase by phase.

Rules you must follow:

Read this entire file before writing code. Then restate the architecture in ≤10 lines in PROGRESS.md to prove you understood it.
One phase at a time. Do not start Phase N+1 until Phase N's "Done when" checklist passes and you have reported results.
Plan first. At the start of each phase, write a short plan (files to create/change, tests to add) and then execute it.
Tests before trust. All game rules live in packages/sim-core and must have unit tests. The battle simulator must have determinism tests (same input → byte-identical output).
Small commits. One logical change per commit with a clear message. Never leave the repo failing typecheck, lint, or test.
Data-driven. Costs, times, stats, and unlock tables live in JSON/TS config files — never hard-coded in logic.
Server is the source of truth (Section 6). The client may predict but never decide.
No copied IP (Section 4). Use only the original names, art, and sounds defined here or ones you create / that have a compatible license.
Ask only when blocked. If something is ambiguous, choose the default in this file, record it in DECISIONS.md, and continue.
Report at the end of each phase: what was built, how to run it, test results, known gaps, and the suggested next step. Keep the report short.
2. PRODUCT VISION AND DESIGN PILLARS
One-line pitch: Build a fortified settlement, grow an army, and raid other players' settlements while they're away — then watch the replay of how they raided yours.

Design pillars (every feature must serve at least one):

A simple, repeatable core loop — Collect resources → Build & train → Raid → (repeat). Progress is always visible and every session has a clear next goal.
Base design is the defender's skill. Defenders cannot act during an attack; their layout (walls, compartments, trap placement, defense coverage) is their strategy.
Army composition and drop placement are the attacker's skill. After troops are dropped, the attacker does not steer them. Troops follow their own targeting rules, so players must predict behavior. This constraint is the heart of the genre.
Asynchronous PvP. Attacker raids a stored snapshot of the defender's base. No real-time netcode is needed for core play.
Time as the pacing mechanism. Upgrades, training, and research take real time; a limited number of builders is the bottleneck.
Interlocking economy. Everything depends on something else (Keep level gates building levels; army camps limit army size; storages limit hoarding; builders limit parallel upgrades).
Server authority. The economy and battle outcomes are decided on the server; cheating is designed out, not patched in.
3. PLATFORM AND SCOPE DEFAULTS
Primary platform: mobile (Android first; iOS second), portrait or landscape (default landscape).
Also runs in a desktop/mobile browser (this is the fastest dev loop).
Art style: 2D, isometric-look rendering over a square logic grid. Placeholder art first (flat colored shapes), then replace with licensed/original art.
Players: solo-first, then online.
Languages: English first; all UI strings in i18n/en.json from day one.
Monetization: optional, ethical (Phase 14). The game must be fully playable and fun without paying.
4. LEGAL / IP GUARDRAILS (read carefully)
I am not a lawyer; get proper legal advice before any commercial release. Practical rules for this project:

Do copy genre conventions and general mechanics: base building on a grid, resource collectors, storage caps, upgrade timers, troop-training queues, asynchronous raids, trophies, clans. Mechanics and genre structure are what many games share.
Do NOT copy anything expressive or branded: no names (game, troops, buildings, characters, resources, spells), no logos, no sprites/icons/UI skins, no sounds/music, no tutorial script, no map layouts, no trade dress. Do not name anything after the reference game or use its terminology as branding (e.g., "Town Hall", "Elixir", "Barbarian", "Clan" as a trademarked proper noun).
This file uses original names (Keep, Gold, Essence, Shards, Axeman, Brute, Sapper, Ballista…). Rename freely, but keep them original.
Art & audio sources: generate original assets, commission an artist, or use assets under permissive licenses (e.g., CC0 packs). Record every external asset's source and license in ASSETS.md.
Fonts and libraries: check licenses; record in THIRD_PARTY.md.
Privacy/compliance: plan for account deletion, data export, parental/age considerations, and region-specific laws (the author is in India; check the DPDP Act and app-store policies). Do this in Phase 15.
5. RESEARCH BASIS — WHAT MAKES THIS GENRE WORK
These findings (from public design analyses and wiki/design-guide material, paraphrased) drive the design below.

Core loop & economy

The loop has three parts — collecting resources, building/training, and battling — and different players weight them differently (builder-heavy vs. raid-heavy styles).
Two main soft currencies exist (one leans toward buildings/defenses, the other toward army/research), with a rarer third and a premium currency. Everything is interdependent: army capacity needs upgraded camps, which need resources, time, and a higher HQ level.
Retention comes from steady visible progress and a loop that rewards each return visit; the first-time experience builds emotional attachment to the village.
Long-running titles in this genre mostly grow by adding troops, balance changes, and social features while leaving the core loop alone.
Combat feel

Players choose where to drop troops, but not what troops do afterward: units pursue targets by their own rules (e.g., some prefer defenses, some prefer walls, some go for resource buildings, otherwise the nearest building). Removing direct control forces planning around predictable AI.
Wall-focused units ignore everything else while any wall remains; wall-jumping units bypass walls but may leave ground support behind; defenses/walls/traps shape the path of troops. Defender layout therefore manipulates attacker pathing.
Pathfinding in this genre is intentionally constrained/simplified so behavior stays readable and exploitable rather than "optimal".
Matchmaking & competition

Matchmaking uses trophy count and HQ level together; earlier versions were gamed by "trophy dumping" (dropping trophies to meet weaker targets), which pushed the designers to weigh HQ level in matching and to add loot penalties/bonuses.
Trophies gained/lost scale with the opponent's trophy difference; at equal trophies the stake is roughly 30, capped around 40 in top leagues; search ranges are bounded (~±200 trophies).
Loot bonuses scale with destruction %, and the HQ itself can hold a loot share that is only awarded if the HQ is destroyed, making it a strategic objective.
More recent design splits play into a casual farming mode and a competitive ranked mode with seasons and league resets, because one ladder could not satisfy both motivations.
Clan wars match clans of similar strength and size, award bonus loot that scales with the base's available loot, and apply the same level-difference loot penalties.
Monetization

Free-to-play games here sell time-skips with premium currency; builders are the classic bottleneck (starting count is low; extra builders are a core monetization lever). A good design keeps early timers short and gifts some premium currency so players learn the system, without relying on frustration.
Architecture

Server-authoritative design means the server runs the rules and decides outcomes; retrofitting authority onto a client-authoritative game later is a rewrite, not a patch. A proven approach is one deterministic rules core shared by client, server, replay, AI, and tests.
6. TECH STACK AND ARCHITECTURE
6.1 Default stack (recommended for AI-assisted development)
Layer	Default	Why	Alternatives
Language	TypeScript everywhere	One language; shared rules library	C# (Unity), GDScript (Godot)
Rules core	packages/sim-core (pure TS, no DOM, no Node APIs)	Shared by client & server; fully unit-testable	—
Client	Phaser 3 + Vite	Fast 2D iteration, runs in browser; package with Capacitor for Android/iOS	PixiJS; Godot 4 (best free 2D engine option); Unity (larger commercial mobile ecosystem)
Server	Node 20+ + Fastify (HTTP) + ws (WebSocket)	Same language as sim-core	Nakama (open-source game backend), PlayFab, Firebase (fast start, weaker for authoritative logic)
Database	PostgreSQL (JSONB for village state)	Transactions, easy queries	Supabase (managed Postgres)
Cache/queues	Redis	Matchmaking pools, rate limits, leaderboards (sorted sets)	—
Tests	Vitest (unit), Playwright (client smoke)		
Tooling	pnpm workspaces, ESLint, Prettier, TypeScript strict		
If you prefer Godot or Unity, keep the same architecture: put all rules in one deterministic module shared with the server (C# is easiest for Unity/Godot-C#; Metaplay-style shared deterministic logic). Do not duplicate rules in two languages.

6.2 Architecture diagram
┌──────────────── Client (Phaser 3 + TS, Capacitor on mobile) ────────────────┐
│ Scenes: Boot · Village · Battle · Replay      UI: shop, army, clan, HUD     │
│ Uses sim-core locally for: placement validation, prediction, replay, scout  │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │ HTTPS (commands, queries)   WebSocket (chat, events)
┌───────────────┴─────────────────────────────────────────────────────────────┐
│ Server (Node + Fastify)                                                     │
│ Auth · Command API · Matchmaker · Battle Verifier · Clans/Chat · Scheduler  │
│ Imports the SAME packages/sim-core                                          │
└───────▲──────────────────────────▲──────────────────────────────────────────┘
        │                          │
   PostgreSQL                     Redis
6.3 Monorepo layout
/
├─ docs/GAME_SPEC.md          (this file)
├─ PROGRESS.md  DECISIONS.md  ASSETS.md  THIRD_PARTY.md
├─ packages/
│  ├─ sim-core/               rules, economy, battle simulation (pure, deterministic)
│  │  ├─ src/{state,commands,economy,build,army,battle,ai,rng,math,validate}/
│  │  └─ test/
│  ├─ game-data/              JSON configs + generator scripts (balance tables)
│  └─ protocol/               shared types for API/WebSocket messages
├─ apps/
│  ├─ client/                 Phaser app (scenes, UI, assets, i18n)
│  ├─ server/                 Fastify API, matchmaker, workers
│  └─ tools/                  balance simulator, base editor, replay CLI, load tester
└─ .github/workflows/         CI: typecheck, lint, test
6.4 Determinism rules (non-negotiable for sim-core)
Fixed timestep: battle simulation runs at 20 ticks/second (50 ms). A 3-minute battle = 3,600 ticks.
Integer / fixed-point math only inside simulation: 1 tile = 1,000 sim-units. No Math.random, no floating-point accumulation, no Date.now(), no Math.sin/cos (use lookup tables if needed).
Seeded PRNG (e.g., mulberry32/xoshiro) in the battle context; the seed is part of the battle record.
Stable ordering: iterate entities by ascending numeric ID; sort ties by ID; never iterate over unordered Maps/Sets for logic.
Pure functions: applyCommand(state, command, ctx) → { state, events } | { error }. ctx holds everything external (server time, RNG state, config version).
Inputs fully describe a battle: { configVersion, seed, defenderSnapshot, attackerLoadout, deployments[{tick, type, x, y}], spellsCast[{tick, type, x, y}] }. Same input ⇒ identical result on every machine.
Never trust client time. The server's clock is the only clock for timers, shields, and production.
Versioned configs: every state/battle stores configVersion; the server keeps old config versions so old replays and in-flight battles still resolve correctly.
7. GAME DESIGN SPECIFICATION
All numbers below are STARTING VALUES. Put them in config, then tune with the balance simulator (Phase 16). They are not taken from any existing game.

7.1 World and grid
Village grid: 40 × 40 buildable tiles inside a 48 × 48 total map (4-tile decorative margin; trees/rocks as removable obstacles that give small rewards and block placement).
Logic is a square grid; rendering is isometric 2:1 (screen = project(tileX, tileY)). Never put logic in screen space.
Buildings occupy rectangular footprints (e.g., 3×3). Placement is valid only if all tiles are inside the grid, unoccupied, and not on a protected tile.
Camera: drag to pan, pinch/scroll to zoom (clamped), tap to select, long-press/drag to move a building in edit mode. Placement shows a ghost: green = valid, red = invalid.
7.2 Resources
Resource	Source	Main use	Notes
Gold	Gold Mines	Buildings, defenses, walls	Soft currency
Essence	Essence Wells	Troops, spells, research	Soft currency
Shards	Shard Vein (unlocks at Keep 7)	Elite units, heroes	Rare, raid-heavy
Gems	Achievements, obstacles, events, IAP	Speed-ups, extra builders, cosmetics	Premium
Collectors produce into an internal buffer (capped); the player taps to collect (offline production accrues up to the buffer cap).
Storages cap how much of each resource the player can hold; overflow is lost. The Keep also provides a small base capacity.
Starting resources: 1,000 Gold, 1,000 Essence, 50 Gems.
7.3 The Keep (HQ) and progression gating
The Keep is the HQ. Its level limits how many of each building you may own and the maximum level of each building and troop. Vertical-slice table (extend to Keep 10 with the same pattern in the generator):

Keep	Max bldg level	Gold Mine	Essence Well	Gold Store	Ess. Store	Barracks	Camp	Ballista	Watchtower	Catapult	Skyspear	Walls (max)
1	2	2	2	1	1	1	1	1	0	0	0	0
2	3	3	3	1	1	2	2	2	1	0	0	25
3	4	4	4	2	2	2	2	2	1	1	1	50
4	5	5	5	2	2	3	3	3	2	1	1	75
5	6	6	6	2	2	3	4	3	2	2	2	100
6	7	6	6	3	3	4	4	4	3	2	2	125
(Also gated: Laboratory at Keep 3, Spell Forge at Keep 3, Clan Castle at Keep 4, Shard Vein + Arcane Spire at Keep 7, Hero Altar at Keep 8.)

7.4 Buildings (original catalog)
Building	Size	Role
Keep	4×4	HQ; holds a loot share; destroying it earns a star
Gold Mine / Essence Well	3×3	Produce resources
Gold Store / Essence Store	3×3	Store resources; hold loot
Barracks	3×3	Train troops (queue)
Army Camp	5×5	Provides housing space for the army (+ a visible troop crowd)
Laboratory	4×4	Research troop/spell levels (one at a time)
Spell Forge	3×3	Brew spells (housing space for spells)
Clan Castle	3×3	Hosts donated troops for defense; reinforces attacks
Builder Lodge (cosmetic per builder)	2×2	Visual home of each builder
Ballista	3×3	Defense: ground only, single target, long range
Watchtower	3×3	Defense: ground + air, single target, lower damage
Catapult	3×3	Defense: ground splash, minimum range, slow fire
Skyspear	3×3	Defense: air only, high damage
Arcane Spire	3×3	Defense: ground + air, splash, short range
Wall	1×1	Blocks ground movement; drag to place lines
Powder Keg / Spike Pit	1×1	Hidden traps (invisible to attacker until triggered)
7.5 Builders and timers
Player starts with 2 builders. Each upgrade/construction occupies one builder until finished. Extra builders (max 5) are bought with Gems at escalating prices (e.g., 250 / 500 / 1,000) and can also be earned through a milestone/achievement so free players can reach 4.
All timers use server timestamps: store finishAt; the server completes things lazily when state is read/synced.
Starting time curves: building level N takes baseTime × 1.6^(N−1); Keep upgrades are slower. Early game: first buildings take seconds, level-2 Keep ≈ 5 min, then 30 min → 3 h → 12 h → 1 d → 2 d → 4 d.
Speed-up cost (Gems) is piecewise-linear in remaining seconds. Anchors (starting values): 60 s → 1, 1 h → 20, 1 d → 260, 7 d → 1,000; interpolate between anchors; minimum 1.
Cost scaling: cost(N) = baseCost × 1.55^(N−1), rounded to nearest 10; refund 0 on cancel except 50% for unstarted queue items.
7.6 Army, housing, training
Housing space is the army size limit: sum(camps' capacity). Each troop has a space cost.
Barracks train from a queue (max 5 queued per barracks); training consumes Essence at enqueue time; troops finish in FIFO order into the army (blocked if housing is full).
Spell Forge brews spells with its own capacity.
Laboratory upgrades unit/spell levels (cost + time), limited by Keep level.
7.7 Troops (original starting stats; level 1)
Speed in tiles/second; range in tiles; sim converts to integers (1 tile = 1,000 units; per-tick = value × 1000 / 20).

Troop	Space	Train	Cost (Ess)	HP	DPS	Range	Speed	Targeting rule
Axeman	1	20 s	25	45	9	0.4	3.0	Nearest building (any)
Archer	1	25 s	50	20	8	3.5	3.0	Nearest building (any); ranged; can hit units
Brute	5	120 s	250	300	12	0.5	1.8	Defenses first, then nearest
Sapper	2	60 s	100	20	6 (×40 vs walls)	0.4	3.5	Walls first while any wall exists; explodes on death
Vaulter	5	150 s	400	140	15	0.5	3.5	Defenses first; jumps over walls
Pilferer	1	25 s	40	25	6 (×2 vs resource bldgs)	0.4	6.0	Resource buildings/storages first
Mender (air)	14	8 min	1,500	90	heals 18 HP/s to ground allies in 2.5 tiles	—	3.0	Follows ground troops; ignores buildings
Wyrmling (air)	20	15 min	3,000	700	25 splash (1 tile)	2.5	2.2	Nearest building; only Skyspear / Watchtower / Spire can hit it
Targeting contract (implement exactly):

A troop chooses a target of its preferred class if any exists; otherwise the nearest valid building; if enemy units are within 2 tiles and can hurt it, it may retaliate (set aggroRadius in config).
"Nearest" = shortest path length (ground) or straight distance (air); tie-break by lowest building ID.
Walls: compute the path treating walls as passable-with-penalty; if the cheapest path crosses a wall segment, the troop attacks the first wall on that path before continuing. This makes compartments and wall layers matter.
Troops retarget when their target dies, becomes unreachable, or a higher-priority class appears (e.g., a Brute re-checks for defenses when its target dies).
Pathfinding: A* on the tile grid with 8-direction movement, corner-cutting disabled between blocked tiles, path cache per (start-region, target); cap A* node expansions per tick to protect performance. Keep paths slightly "dumb" on purpose (predictability over optimality).
7.8 Spells (original)
Spell	Space	Effect
Bolt	2	Instant area damage to buildings/units
Mend	2	Heals units in radius over time
Frenzy	2	Raises damage and speed in radius for N seconds
Frost	1	Freezes defenses/units in radius for N seconds
Spells are cast by position + tick, so they are part of the replay input.

7.9 Defenses and traps (level 1)
Defense	HP	Damage	Fire rate	Range (min–max)	Targets	Special
Ballista	320	11 DPS	continuous	0–9	ground	—
Watchtower	280	8 DPS	continuous	0–10	ground + air	—
Catapult	300	20 per 5 s shot	5 s	4–11	ground	1.5-tile splash
Skyspear	300	16 DPS	continuous	0–10	air	—
Arcane Spire	400	25 per 2 s	2 s	0–7	ground + air	1-tile splash
Wall	300	—	—	—	—	Level scaling ×1.4/level
Powder Keg	—	150 splash (1.5 tiles)	one-shot	trigger 1.5 tiles	ground	Invisible until triggered
Spike Pit	—	Instantly kills ground troops totalling ≤ 15 housing space in radius 1	one-shot	trigger 1 tile	ground	Invisible until triggered
Defenses pick the nearest valid enemy in range (ties → lowest ID) and keep the target until it dies or leaves range.
Clan Castle troops spawn when any attacker unit comes within a trigger radius (default 8 tiles from the castle), then fight with their own AI.
7.10 Battle rules
Scouting: unlimited time to inspect the enemy base; the attack timer (180 s) starts at the first deployment.
Deploy zone: any tile at least 2 tiles away from any building footprint. Air units may deploy anywhere within the 48×48 map. Show red overlay on invalid zones.
Ends when: destruction = 100%, timer reaches 0, or all deployed troops are dead and nothing is left to deploy.
Destruction % = destroyed countable buildings ÷ total countable buildings (exclude walls, traps, obstacles).
Stars: ★ at ≥50% destruction · ★ for destroying the Keep · ★ at 100%.
Loot: available loot per player = a % of stored resources (start: 20% of Gold and Essence, capped per Keep level). Distribution: the Keep holds a share equal to one storage and is only looted if destroyed; each storage's share is awarded proportionally to damage dealt to it; collectors' uncollected buffers are lootable up to 50%. A level-difference penalty reduces loot when the attacker's Keep is higher than the defender's (start: −10% per level, floor 50%). Loot taken is deducted from the defender at verification time.
Trophies: stake T = clamp(30 + (defenderTrophies − attackerTrophies)/20, 10, 40). Attacker gains round(T × stars / 3); defender loses the same amount (never below 0). 0 stars = no change.
Shield: after being attacked with ≥30% destruction the defender gets a shield (30–59% → 6 h, 60–89% → 10 h, 90–100% → 14 h). Attacking while shielded breaks the shield (show a confirm dialog). New players get a 3-day guard that ends when they raid.
Matchmaking (MVP): candidates = not shielded, not currently online or locked, not raided by this attacker in the last 24 h; Keep level within ±1 (prefer equal); trophy gap ≤ 200 initially, widening +100 every 5 failed "Next" searches; each "Next" costs Gold (scales with Keep). Cache and lock a snapshot of the defender's base for the duration of the attack (TTL 3 min + grace).
7.11 Clans (Phase 10+)
Up to 30 members; roles: Member, Elder, Co-leader, Leader. Join by search/invite; open/invite-only/closed.
Chat (WebSocket), troop requests/donations (donated troops sit in the Clan Castle and defend; the donor's troops are used by the requester in attack). Donation limit per day.
Clan Wars (Phase 11): matched by size and strength, 24 h preparation + 24 h battle, 2 attacks per member, stars summed; winner gets a bonus loot pool; level-difference penalties apply.
7.12 Onboarding (Phase 9)
First 5 minutes are scripted: place Gold Mine → collect → build Barracks (instant finish via gifted Gems to teach the mechanic) → train 6 Axemen → attack a scripted weak village → earn first stars → introduce walls and the second builder timer.
Early timers are seconds/minutes. The "wait" is introduced gradually. Gift a small Gem balance so players learn speed-ups without feeling pressured.
8. DATA MODEL, PROTOCOL, AND DATABASE
8.1 Config schemas (packages/game-data)
ts
type ResourceId = 'gold' | 'essence' | 'shards' | 'gems';

interface BuildingDef {
  id: string;                 // 'gold_mine'
  category: 'economy'|'storage'|'army'|'defense'|'trap'|'wall'|'hq'|'misc';
  size: { w: number; h: number };
  levels: BuildingLevel[];    // generated from curves by scripts/gen-balance.ts
  unlock: { keepLevel: number };
}
interface BuildingLevel {
  level: number;
  hp: number;
  cost: Partial<Record<ResourceId, number>>;
  buildSeconds: number;
  requiresKeep: number;
  // economy
  productionPerHour?: number; bufferCap?: number;
  // storage
  storageCap?: Partial<Record<ResourceId, number>>;
  // army
  housing?: number; queueSlots?: number;
  // defense
  dps?: number; shotDamage?: number; fireIntervalTicks?: number;
  rangeMin?: number; rangeMax?: number; splashRadius?: number;
  targets?: ('ground'|'air')[];
}

interface TroopDef {
  id: string; space: number; isAir: boolean;
  levels: { level: number; hp: number; dps: number; trainSeconds: number;
            cost: Partial<Record<ResourceId, number>>; labCost: any; labSeconds: number; }[];
  speedTilesPerSec: number; range: number;
  target: { prefer: 'any'|'defense'|'wall'|'resource'|'none'; jumpsWalls?: boolean;
            wallMultiplier?: number; resourceMultiplier?: number; aggroRadius: number; };
}
8.2 Player state (authoritative, stored server-side)
ts
interface PlayerState {
  version: number;                 // optimistic concurrency
  configVersion: string;
  keepLevel: number;
  resources: Record<ResourceId, number>;
  builders: { count: number; busy: { buildingId: number; finishAt: number }[] };
  buildings: BuildingInstance[];   // id, type, level, x, y, upgrade?: {toLevel, finishAt}, bufferStartedAt?
  obstacles: { id: number; type: string; x: number; y: number }[];
  army: Record<string, number>;    // troopId -> count
  trainingQueues: { barracksId: number; items: { troopId: string; finishAt: number }[] }[];
  research: { active?: { unitId: string; toLevel: number; finishAt: number }; levels: Record<string, number> };
  spells: Record<string, number>;
  trophies: number; shieldUntil?: number; guardUntil?: number;
  clan?: { clanId: string; role: string };
  tutorialStep: number;
  lastSyncAt: number;              // server time
}
8.3 Command protocol
Every mutating action is a command sent as { id: uuid, type, payload, clientSeq }. The server validates with sim-core and responds with the new state (or a diff) plus events. Commands are idempotent by id.

Command	Purpose
PlaceBuilding, MoveBuilding, RemoveObstacle	Layout editing
StartUpgrade, CancelUpgrade, SpeedUp	Construction timing
CollectResource	Tap collectors
QueueTroop, CancelTroop, QueueSpell	Army
StartResearch, SpeedUpResearch	Lab
RequestScout → returns target snapshot & lock	PvP
SubmitBattle	Send deployment log for verification
ClaimReward, BuyBuilder, BuyPack	Economy/monetization
Clan: CreateClan, JoinClan, LeaveClan, RequestTroops, DonateTroops, SendChat	Social
8.4 Database (PostgreSQL) — starting schema
sql
CREATE TABLE players (
  id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  auth_provider TEXT NOT NULL, auth_subject TEXT NOT NULL, display_name TEXT,
  UNIQUE (auth_provider, auth_subject)
);
CREATE TABLE player_state (
  player_id UUID PRIMARY KEY REFERENCES players(id),
  version INT NOT NULL, config_version TEXT NOT NULL,
  state JSONB NOT NULL, trophies INT NOT NULL DEFAULT 0,
  keep_level INT NOT NULL DEFAULT 1, shield_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON player_state (keep_level, trophies);
CREATE TABLE battles (
  id UUID PRIMARY KEY, attacker_id UUID NOT NULL, defender_id UUID NOT NULL,
  seed BIGINT NOT NULL, config_version TEXT NOT NULL,
  defender_snapshot JSONB NOT NULL, inputs JSONB NOT NULL, result JSONB NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE clans (id UUID PRIMARY KEY, name TEXT UNIQUE, description TEXT, join_mode TEXT, trophies INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE clan_members (clan_id UUID, player_id UUID UNIQUE, role TEXT, joined_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (clan_id, player_id));
CREATE TABLE chat_messages (id BIGSERIAL PRIMARY KEY, clan_id UUID, player_id UUID, body TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE iap_receipts (id UUID PRIMARY KEY, player_id UUID, store TEXT, product_id TEXT, token TEXT UNIQUE, validated_at TIMESTAMPTZ, granted JSONB);
CREATE TABLE seasons (id SERIAL PRIMARY KEY, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ);
Redis: lb:season:{id} sorted set (leaderboards), mm:keep:{n} matchmaking pools, lock:defender:{id} attack locks (TTL), rl:{player}:{route} rate limits.

9. ART, UX, AND AUDIO DIRECTION
Placeholder-first: every building/troop starts as a flat colored shape with a text label so gameplay can be judged before art exists. Swap art in via an atlas + assets.json manifest; never hard-code image paths in logic.
Readability over detail: distinct silhouettes per troop/defense; color-coded range rings on selection; red/green validity plus a pattern/icon (so it works for colour-blind players).
UI: bottom action bar (Shop, Army, Attack, Clan), top resource bars with caps, builder icons with timers, notification badges. Large touch targets (≥ 44 px).
Juice (cheap, high value): floating numbers on collect, dust on construction complete, hit flashes, screen shake on Keep destruction, star animations, satisfying "tap-to-collect" sound.
Audio: short UI sounds, ambient village loop, battle loop; keep total audio small; expose volume + haptics toggles.
Performance budget: 60 FPS on a mid-range phone; ≤ 150 draw calls (use atlases + culling); ≤ 150 MB RAM; first-load ≤ 40 MB.
Accessibility: scalable text, high-contrast mode, reduce-motion toggle, no information conveyed by colour alone.
10. PHASED IMPLEMENTATION PLAN
For every phase: write a plan, implement, test, then report. Do not start the next phase until Done when passes.

PHASE 0 — Bootstrap & tooling (M1)
Goal: a clean, testable monorepo with a running client shell. Build

pnpm workspace with packages/{sim-core,game-data,protocol} and apps/{client,server,tools}; TypeScript strict, ESLint, Prettier, Vitest, path aliases.
Scripts: pnpm dev, pnpm test, pnpm typecheck, pnpm lint, pnpm build.
CI workflow running typecheck + lint + test on every push.
Client: Vite + Phaser 3 boot scene that renders the 48×48 isometric grid, with mouse/touch pan and pinch/scroll zoom (clamped) and an FPS counter.
Create PROGRESS.md, DECISIONS.md, ASSETS.md, THIRD_PARTY.md, README.md (how to run). Done when
 CI is green on a fresh clone.
 pnpm dev shows the iso grid; pan/zoom works with mouse and touch emulation.
 sim-core has one passing sample test and imports cleanly into client and server.

PHASE 1 — Sim-core foundations (M1)
Goal: the deterministic skeleton every rule will hang on. Build

math (fixed-point helpers, integer sqrt/hypot), rng (seeded PRNG with serializable state), grid (occupancy map, footprint checks).
State types (Section 8.2), createNewPlayerState() with starting resources, Keep, and starter buildings.
Config loader with schema validation (use Zod or similar); fail loudly with helpful messages. Initial configs: Keep, Gold Mine, Essence Well, Gold/Essence Store, Wall, obstacles.
Command pipeline: applyCommand(state, cmd, ctx) with a typed result (ok + events | error + code). Implement PlaceBuilding, MoveBuilding, RemoveObstacle (stub reward).
Stable (sorted-key) JSON serialization + hashState() for tests and replay checks. Tests
Placement: out of bounds, overlap, margin, exact-fit edges, moving onto itself, walls adjacent.
RNG determinism across 1M draws; serialization round-trip; invalid-config rejection. Done when
 ≥ 90% line coverage on state, grid, commands.
 Same command list → identical hashState() on repeated runs.

PHASE 2 — Economy & construction (M1)
Goal: a complete, correct economy with timers — no UI yet. Build

Lazy time evaluation: catchUp(state, now) completes finished upgrades, advances training queues, and fills collector buffers up to their caps. Every command first calls catchUp.
Collectors: production per hour with buffer caps; CollectResource respects storage caps (overflow lost, report it in the event).
Costs, Keep gating (Section 7.3), builder assignment, StartUpgrade/CancelUpgrade (refund rules), SpeedUp with the piecewise gem formula, BuyBuilder.
packages/game-data/scripts/gen-balance.ts: generates level tables for Keep 1–6 from base values + growth curves (cost ×1.55, time ×1.6, hp/dps curves) and writes JSON. Humans tune the base values only. Tests
8-hour offline catch-up; buffer cap; storage overflow; two builders busy → third upgrade rejected; Keep gating; cancel refund; gem-cost anchors; "two commands in the same millisecond"; time never goes backwards (reject). Done when
 A scripted 7-day simulation in a test (sim:playthrough) reaches Keep 3 using only free resources with no invalid states.
 No test depends on wall-clock time (inject now).

PHASE 3 — Client: Village scene & building UX (M1)
Goal: a player can build and manage a village in the browser. Build

Render buildings (placeholder shapes), obstacles, walls; selection with range ring and info panel.
HUD: resource bars with caps, builder icons with countdowns, gem counter.
Shop (categories, locked items show the unlock requirement), placement ghost (green/red + pattern), move mode, drag-to-place walls, upgrade panel (cost, time, resulting stats, builder availability, speed-up button).
Tap-to-collect with floating numbers; obstacle removal; build/upgrade progress bars; completion toasts.
Local persistence in IndexedDB (temporary), autosave on every command, safe migration versioning.
All text via i18n; touch + mouse + keyboard-friendly. Tests
Playwright smoke: new game → place mine → wait (mock time) → collect → upgrade.
Unit tests for UI state machines (placement mode, selection). Done when
 A new player can reach Keep 2 in the browser with correct timers, caps, and gating.
 60 FPS with 300 placed objects on a mid-range laptop; no console errors.

PHASE 4 — Army, spells, laboratory (M1)
Goal: build an army that obeys housing limits. Build

Barracks queues, Army Camps (housing), training (consumes Essence on enqueue), FIFO completion with catchUp, housing-full blocking.
Spell Forge brewing; Laboratory research (one at a time, cost + time, Keep-gated levels).
Troop configs: Axeman, Archer, Brute, Sapper, Vaulter, Pilferer (levels 1–3); Mender/Wyrmling definitions can be stubbed until Phase 13.
UI: army overview, training panel (tap/hold to add), camps visually show troops, lab panel. Tests
Queue ordering, cancel refunds, housing limits, research gating, offline training completion. Done when
 A player can train a mixed army up to the housing cap and research a troop level.
 Army state persists across reloads and offline time.

PHASE 5 — Battle simulator (headless) (M1)
Goal: the most important system, built and proven without any graphics. Build

World build from a defenderSnapshot (buildings, walls, traps, clan-castle troops) + attackerLoadout.
Tick loop at 20 Hz with stable entity ordering; deploy and spell commands consumed at their ticks.
Troop AI: target selection per the Targeting Contract (Section 7.7), wall-aware pathfinding, retargeting, aggro, jump/wall-breaker behaviors, healing (Mender), explosions (Sapper), air units.
Defense AI: nearest-valid-target, min/max range, projectile travel time (can be instant in MVP), splash, shot cadence, Frost handling.
Traps: hidden until triggered, one-shot, housing-space thresholds.
Spells: Bolt, Mend, Frenzy, Frost.
Clan Castle: trigger radius, defender troops spawn and fight.
Results: destruction %, stars, loot (Section 7.10), trophy delta; full event log (spawned, moved, attacked, damaged, destroyed, spell) for replay and VFX.
Tools: apps/tools/base-editor (author bases as JSON, visualize in terminal or simple canvas), pnpm sim:run battle.json CLI printing results, and a benchmark. Tests
Determinism: run the same battle 100× → identical event-log hash.
Behavior suite: Sapper breaches walls first; Vaulter ignores walls; Brute prefers defenses; Pilferer prefers resources; ground-only defenses cannot hit air; Catapult minimum range; Spike Pit kills ≤ threshold; Frost stops fire; Frenzy changes DPS; walls force detours; sealed compartments make troops attack walls; troop with no path attacks the cheapest wall.
Golden files: 10 fixture battles with checked-in expected outputs.
Perf: 3,600 ticks with ~150 buildings and ~120 units completes in a target time (start: < 300 ms on a typical dev machine) and never exceeds the A* node cap. Done when
 All tests pass; benchmarks recorded in PROGRESS.md.
 Results from two different machines/Node versions match byte-for-byte.

PHASE 6 — Battle client, replays, and offline campaign (M1 complete)
Goal: satisfying raids against AI villages, fully offline. Build

Battle scene: load base, free scouting camera, army/spell trays, drop-by-tap (with a drop-rate limit per tick), 180 s timer starting at first drop, destruction % bar, stars, surrender button.
Visualization of the event log: movement, attacks, projectiles, damage numbers, building destruction, loot popping out, trap reveals, spell VFX, hit-stop on big events.
Results screen: stars, loot, trophies, buttons (Replay, Home).
Replay system: the attack is just {seed, snapshot, inputs}; playback at 1×/2×/4×, pause, free camera.
Campaign: 15 hand-authored AI villages (made with the base editor) escalating in difficulty; first-time rewards; teaches layouts and troop counters.
Training-ground "test attack" on your own base (no loot, no risk) — helps players test their layouts. Done when (M1 acceptance)
 A fresh install can play 30 minutes offline: build, collect, train, raid 3 campaign villages, watch a replay.
 Replay plays identical results to the live battle (hash match).

PHASE 7 — Backend foundation & cloud save (M2)
Goal: accounts and a server-authoritative village. Build

Server skeleton (Fastify), env config, structured logging, health check, Docker Compose (Postgres + Redis) for dev, migrations (Section 8.4).
Auth: guest login by device ID → JWT access + refresh tokens; later link Google/Apple (needed to recover accounts). Rate-limit by IP/player.
State API: GET /state (returns catchUp-ed state), POST /command (validate with sim-core, apply, persist with optimistic-concurrency version, idempotent by command id).
Shared protocol package with request/response schemas (Zod) used by both client and server.
Client networking layer: optimistic prediction using local sim-core; on server rejection roll back and show a clear message; offline queue with retry/backoff; "connection lost" UX.
One-time migration of the local IndexedDB save → cloud account.
Integration tests (spin up server + DB in CI), simple load test script. Tests
Replay a command log against server and local sim → identical hashState().
Reject tampered payloads (negative costs, impossible placement, time travel). Done when (M2 acceptance)
 Two devices logged into the same account see the same village; a hacked client cannot give itself resources.

PHASE 8 — Asynchronous PvP (M3)
Goal: real players raid each other's bases fairly and safely. Build

Matchmaker: Redis pools keyed by Keep level and trophy bucket; RequestScout returns a candidate that is unshielded, not locked, not recently raided by this attacker; widening search; each "Next" costs Gold. If the pool is thin, return a generated bot base so players never wait.
Snapshot & lock: store a frozen copy of the defender's base in the battle row; lock the defender (TTL 3 min + grace). Defender edits during the attack do not affect it.
SubmitBattle: the client submits {battleId, inputs}; the server re-simulates with the stored seed and snapshot and ignores any client-claimed result. Mismatch → use the server's result and flag the account.
Atomic settlement: in one DB transaction (lock both rows in a consistent ID order): deduct loot from the defender, credit the attacker (respecting storage caps), apply trophies and shield rules, write the battle row, update leaderboards.
Defense log & replays: list of recent raids with stars, loot lost, attacker name, and "Watch replay". Revenge button (time-limited free scout of the attacker).
Edge cases: double submit (idempotent), attacker disconnects (auto-resolve with deployments so far after TTL), defender deleted/banned, lock expiry, negative balances impossible, matchmaker pool updates on every state change.
Loot penalties (level difference), trophy math (Section 7.10), shields and the new-player guard. Tests
Concurrency: simultaneous attacks on one defender (only one lock holder); double-submit; crash mid-settlement (transaction atomicity).
Property tests: total resources conserved (defender loss = attacker gain before caps). Done when (M3 core acceptance)
 Two real accounts can raid each other end-to-end, with correct loot/trophies/shields and a watchable replay on both sides.
 Tampered battle submissions are detected.

PHASE 9 — Onboarding, achievements, notifications (M3 complete)
Goal: a new player understands the loop in five minutes and wants to come back. Build

Scripted first-session flow (Section 7.12) driven by tutorialStep in server state; skippable only after completion; resilient to app kills mid-tutorial.
Gifted Gems for the first speed-up; a "next goal" arrow system (always show the single best next action).
Achievements (e.g., "collect 10,000 Gold", "3-star a village") granting Gems; daily login reward; obstacle-clearing rewards.
Push notifications (opt-in): upgrade/training finished, you were attacked, shield expiring. Local notifications first, server push later. Respect quiet hours.
Settings: language, audio, haptics, notifications, account link, delete account. Done when
 Usability test with 3 new players: ≥ 2 of 3 complete the first raid without help.
 Tutorial survives force-quit at every step.

PHASE 10 — Clans, chat, donations (M4)
Goal: social glue that drives retention. Build

Create/search/join/leave clans; roles and permissions; join modes (open/invite/closed); clan profile; member list with trophies.
WebSocket chat with rate limits, profanity filter hook, report/mute, message history (last 100).
Troop requests & donations with daily caps; donated troops live in the Clan Castle and defend; requesters can use them in attack.
Server-side validation for every social action; audit log for leadership actions. Tests
Permission matrix; donation accounting (no duplication, no negative); chat flood limit. Done when
 Two accounts in a clan can chat, request, and donate; donated troops appear in defense and attack simulations.

PHASE 11 — Clan wars (M4, stretch)
Goal: a scheduled team competition. Build

War matchmaking by clan size and strength, 24 h preparation + 24 h battle; war base layout is snapshotted at prep end.
Each member gets 2 attacks; best result per target counts; stars sum; tie-breakers by destruction %.
War loot pool awarded to winners proportional to stars (with level-difference penalty); war log and replays.
Scheduler worker with idempotent state transitions (prep → battle → settle). Done when
 A full war cycle runs in a time-accelerated test environment with correct results and no double payouts.

PHASE 12 — Leagues, seasons, leaderboards (M4)
Goal: a competitive ladder that doesn't hurt casual farmers. Build

Leagues by trophy ranges; per-season reset (e.g., soft reset toward a base value) with end-of-season rewards.
Optional mode split: Raid (casual, loot-focused, matchmaking by Keep level, no trophies) vs Ranked (league progress, trophies, seasonal). This addresses the "trophy dumping" and "farmer vs competitor" tension.
Redis leaderboards (global, by region, by clan); anti-dumping rules: matchmaking weighs Keep level and trophies; loot bonuses scale with destruction %.
Season scheduler and history. Done when
 A simulated season of bots produces sane trophy distributions with no runaway inflation; leaderboards update within seconds.

PHASE 13 — Heroes and content expansion (M5)
Goal: long-term depth. Build

Hero Altar and 1–2 heroes (reusable units with abilities and recovery timers instead of consumption); hero equipment/upgrades.
Mender and Wyrmling fully implemented; Keep 7–10 content; Shard Vein; Arcane Spire; new traps (e.g., Launch Pad).
Content pipeline: add a troop/building by editing config + a short test, no engine changes. Done when
 New content can be added in < 1 hour using only config and tests; all Phase 5 determinism tests still pass.

PHASE 14 — Monetization & live operations (M5)
Goal: sustainable, fair revenue; safe live updates. Design rules (ethical defaults)

No pay-to-win advantage that bypasses skill in PvP; paying buys time and convenience and cosmetics.
Early timers are short; a few gems are gifted; the 3rd+ builder is purchasable and partly earnable.
No randomized paid loot boxes. Show clear prices and what you get. Offer spending limits/parental controls. Build
Store: gem packs, starter pack, builder purchase, building/troop skins, season pass (free + premium track).
Server-side receipt validation (Google Play / App Store server APIs); idempotent grants via iap_receipts; refund/revoke handling.
Remote config + feature flags (event schedules, price tests, balance hot-fixes via new configVersion); limited-time events with special troops/rewards.
Ads are optional (rewarded only), off by default. Done when
 A test purchase grants items exactly once (even with retries); a config change goes live without an app update.

PHASE 15 — Security, anti-cheat, compliance (M5)
Build / verify (use the checklist in Section 13)

Threat model document; dependency audit; secrets management; backups and restore drill.
Rate limits, abuse reports, ban tooling, admin panel (read-only first).
Privacy: policy, consent flows, data export, account deletion, age gating per app-store rules; region-specific requirements (check India's DPDP Act and platform policies with counsel). Done when
 Red-team script (modified client) fails to: gain resources, skip timers, forge battle results, or replay old commands.

PHASE 16 — Analytics, balance simulator, QA (M5)
Build

Event analytics (privacy-respecting): funnel for first session, upgrade/train/raid counts, D1/D7/D30 retention, session length, soft-currency sources/sinks, gem sinks.
Balance simulator (apps/tools/balance): Monte Carlo battles (N seeds) of army A vs base B → win/star distribution; economy ledger simulation for F2P vs light-spender paths; flag outliers (units that dominate/never get used).
Starting target hypotheses (tune with real data): first session reaches Keep 2; Keep 3 within ~2 days of casual play; no single troop composition above ~60% 3-star rate against fully-upgraded same-Keep bases.
QA: automated regression suite (sim + API + client smoke), device matrix, soak test (24 h bots), chaos test (kill server mid-settlement). Done when
 A one-command report outputs balance tables and flags; soak test shows no data corruption or resource leaks.

PHASE 17 — Performance, packaging, soft launch (M5)
Build

Profile CPU/GPU/memory on low- and mid-range Android; texture atlases, culling, object pooling, lazy-loaded scenes.
Capacitor builds (Android first); signing, versioning, crash reporting, forced-update mechanism for incompatible configVersion.
Infra: containerized server, managed Postgres/Redis, horizontal scale for stateless API, background workers, monitoring/alerts, runbooks.
Soft launch in a small region; measure retention and funnel; fix top issues before wider release. Done when
 Meets the performance budget (Section 9); crash-free sessions target defined and measured; store listing assets ready.
11. TESTING STRATEGY
Layer	What	Tooling
Unit	Every rule in sim-core; ≥ 90% coverage on state/commands/economy/battle	Vitest
Property	Resource conservation, no negative balances, idempotent commands, queue invariants	fast-check (or similar)
Determinism	Same inputs → same event-log hash across 100 runs and across machines	Golden files in CI
Integration	API + DB + Redis end-to-end flows	Vitest + supertest + Docker
Client smoke	New game → build → collect → train → raid → results	Playwright
Load/soak	Concurrent players, matchmaking contention, settlement transactions	k6 or custom script
Chaos	Kill processes mid-transaction; duplicate/reordered requests	Scripted
Playtest	Human checklist after each milestone	Manual
Playtest checklist (after M1, M3): Is the first raid winnable within 5 minutes? Can I always tell what to do next? Do I understand why my raid failed? Do walls matter? Is waiting acceptable? Any moment I felt cheated or confused?

12. BALANCING APPROACH
Curves, not spreadsheets: define base value + growth rate per stat; generate tables by script; tune 5–10 numbers instead of thousands.
Time ladder: early upgrades in seconds/minutes; later ones in hours/days; keep Keep upgrades as the major pacing gates.
Economy health: track daily sources/sinks per resource; if resources pile up, add sinks; if players are always broke, raise income or lower costs.
Counter-play map: every troop has a counter and every defense has a weakness (walls vs. Vaulters; Sapper vs. compartments; air vs. Skyspear; splash vs. swarms). Check with Monte Carlo.
Predictability over realism: keep AI rules simple and discoverable so players can plan and defenders can design layouts.
Change slowly: ship balance via configVersion, with changelogs; avoid mid-season nerfs to paid content.
13. SECURITY & ANTI-ABUSE CHECKLIST
 All state mutations go through applyCommand on the server; client results are never trusted.
 Server clock only; reject commands with impossible timestamps or sequence gaps.
 Idempotency keys on commands, purchases, settlements.
 Battle results come from server re-simulation; mismatches are flagged.
 JWT with short expiry + refresh rotation; device binding; revoke on suspicious activity.
 Rate limiting per IP/player/route; WebSocket message limits.
 Input validation (Zod) on every endpoint; output encoding for chat/names.
 Receipts validated server-side; no client-granted purchases.
 Row-level locking order to avoid deadlocks; transactions for all multi-row changes.
 Secrets in env/secret manager; least-privilege DB roles; encrypted backups tested.
 Logging without personal data; audit logs for admin actions.
 Minimal client-side secrets (assume the app can be decompiled).
14. KEY RISKS AND MITIGATIONS
Risk	Mitigation
Scope creep (this genre is huge)	Hard milestones; ship M1/M3 before any social/monetization work
Determinism bugs	Integer math, no wall-clock/random in sim, golden tests in CI
Cheating	Server authority + re-simulation; red-team script in Phase 15
Performance (pathfinding)	A* node caps, path caching, region-based pathing, benchmarks in CI
Empty matchmaking pool	Bot bases generated from templates so there is always a target
Economy inflation/deflation	Source/sink ledger + balance simulator
Player boredom with waiting	Short early timers, always-available productive actions (raids, campaign, lab)
Legal/IP exposure	Original names/art, asset ledger, legal review before launch
Backend cost	Stateless API, JSONB state, Redis caching, load tests before launch
Store policy/compliance	Account deletion, privacy policy, age gating, transparent purchases
15. DEFINITION OF DONE (project level)
 M1: Fresh install plays 30 minutes offline; replays match live battles byte-for-byte.
 M2: Cloud account; hacked client cannot cheat resources/timers.
 M3: Two real accounts raid each other end-to-end with correct loot/trophies/shields/replays.
 M4: Clans, chat, donations, (optional) wars, leagues/seasons.
 M5: Heroes/content, ethical monetization, security review, analytics, soft-launch build.
 CI is green; docs (README, PROGRESS.md, DECISIONS.md, ASSETS.md, THIRD_PARTY.md) are current.
16. PASTE-READY PROMPTS
16.1 Kickoff Prompt (paste once, at the start)
text
You are a senior game engineer. Read docs/GAME_SPEC.md completely.

1. In PROGRESS.md, summarize the architecture in at most 10 lines and list the milestones.
2. Create DECISIONS.md, ASSETS.md and THIRD_PARTY.md (empty templates).
3. Do PHASE 0 only (Bootstrap & tooling). Follow the working agreement in Section 1.
4. When finished, report: what you built, how to run it, test results, any deviations from the spec, and the plan for Phase 1.
Do not start Phase 1 until I say "Proceed to Phase 1".
16.2 Phase Prompt Template (paste for each phase)
text
Proceed to PHASE {N} — {TITLE} from docs/GAME_SPEC.md.

- First write a short plan (files to add/change, tests to write).
- Implement only this phase. Keep earlier phases' tests passing.
- Use the data-driven configs; no hard-coded numbers in logic.
- Update PROGRESS.md and DECISIONS.md.
- Finish with a report: what changed, how to run/verify, test + benchmark results, known gaps, and the "Done when" checklist with each item marked pass/fail.
Do not start the next phase.
16.3 Useful follow-up prompts
Review: Review the code from Phase {N} as a skeptical senior engineer. List correctness, determinism, security, and performance risks, ranked by severity, with fixes. Do not change code until I approve.
Debug: Here is the failing test/output: {paste}. Find the root cause (do not patch symptoms), write a failing test that reproduces it, then fix it.
Balance: Run the balance simulator for {army} vs {base}. Report star distribution, average destruction, and which unit contributes most. Suggest config-only tweaks.
New content: Add a new troop "{name}" with {behavior}. Config + tests only; update the counter-play map and the balance report.
Art swap: Replace placeholder art for {asset list} using the assets in /assets/{pack}. Update ASSETS.md with source and license for each file.
17. SOURCES (research basis)
Design analysis and wikis (paraphrased, not quoted):

Deconstructor of Fun — "Clash of Clans – the Winning Formula": https://www.deconstructoroffun.com/blog//2012/09/clash-of-clans-winning-formula.html
PocketGamer.biz — "Deconstructing Clash of Clans' Builder Base": https://www.pocketgamer.biz/comment-and-opinion/66056/deconstructing-clash-of-clans-the-builder-base/
Ludus Novus — "You Can't Control Clash of Clans": https://ludusnovus.net/2015/08/29/you-cant-control-clash-of-clans/
Supercell — "Battle and Ranked Modes Are Coming to Clash": https://supercell.com/en/games/clashofclans/blog/news/battle-and-ranked-modes-are-coming-to-clash-
Clash of Clans Wiki — Legend League Tournaments: https://clashofclans.fandom.com/wiki/Legend_League_Tournaments
Clash of Clans Wiki — Hog Rider: https://clashofclans.fandom.com/wiki/Hog_Rider · Wall Breaker: https://clashofclans.fandom.com/wiki/Wall_Breaker
Gospel Herald — May 2015 matchmaking/trophy-dumping update: https://www.gospelherald.com/news/clash-of-clans-update-may-2015-matchmaking-algorithms-changed-as-trophy-dumping-is-addressed
TouchArcade — Town Hall 11 loot/league bonus preview: https://toucharcade.com/2015/11/25/another-clash-of-clans-town-hall-11-update-preview-loot-league-bonuses-and-trophy-offers-changing/
RealSport101 — Versus battles, matchmaking and trophy rules: https://realsport101.com/article/clash-of-clans-versus-battles-explained-matchmaking-gameplay-rewards-fully-explained-guide
TrophyCoach — Trophy pushing & Legend League guide: https://trophycoach.com/clash-of-clans/guides/trophy-pushing-legend-league-guide
Preprint — "Troop Pathfinding and Target Selection Algorithms in Clash of Clans–Style War": https://www.preprints.org/frontend/manuscript/adf60ea5beceb83e765f028bd31aa7ab/download_pub
Monetization:

Engadget — "The waiting game: Hands-on with Clash of Clans": https://www.engadget.com/2014-01-22-the-waiting-game-hands-on-with-clash-of-clans.html
PocketGamer.biz — "Why the third builder bottleneck is crucial…": https://www.pocketgamer.biz/monetizer-why-the-third-builder-bottleneck-is-crucial-to-monetising-clash-of-clan-clones/
Architecture and tooling:

Metaplay — Server-authoritative vs client-authoritative: https://www.metaplay.io/comparisons/server-authoritative-vs-client-authoritative
DEV Community — One deterministic core for local play, AI and multiplayer: https://dev.to/ernest_dev/inside-the-architecture-4x-strategy-game-one-core-for-local-play-ai-and-multiplayer-8l1
Oceanview Games — Unity vs Godot vs Unreal for mobile: https://oceanviewgames.co.uk/blog/posts/unity-vs-godot-vs-unreal-for-mobile-games
Godot multiplayer backend services in 2026: https://crux.supercraft.host/blog/godot-multiplayer-backend-services-what-indie-devs-use-2026/
Numbers in Sections 7 and 12 are original starting values for tuning, not data from any existing game. Proprietary game internals are not public; behaviors here are re-created from observable, documented gameplay.
