-- Teen Beach Moonta — camp location board (Cloudflare D1)
-- Apply with:  npx wrangler d1 execute teenbeach --remote --file=./schema.sql
--
-- WARNING: this drops and rebuilds every table, so it wipes the roster along
-- with it. Run it once when you set the site up, and again only if you really
-- want to start from scratch.

DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS movements;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS aiders;
DROP TABLE IF EXISTS meta;

-- Everyone at camp. `place` is where they are right now: 'onsite', 'home',
-- or the id of an activity. There is no separate in/out flag — a scan just
-- moves someone to the place the desk has selected.
CREATE TABLE members (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  crew    TEXT,
  place   TEXT NOT NULL DEFAULT 'onsite',
  since   INTEGER,                       -- ms timestamp of the last move
  created INTEGER
);

CREATE TABLE movements (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  code  TEXT NOT NULL,
  place TEXT NOT NULL,                   -- where they moved to
  t     INTEGER NOT NULL
);
CREATE INDEX movements_t ON movements (t DESC);

CREATE TABLE activities (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  loc   TEXT,
  date  TEXT NOT NULL,                   -- YYYY-MM-DD
  start TEXT NOT NULL,                   -- HH:MM
  end   TEXT NOT NULL,
  kind  TEXT DEFAULT 'main',             -- main | extra | onsite | meal | cater | camp
  site  TEXT DEFAULT 'on',               -- 'on' = on site, 'off' = away from camp
  dest  INTEGER DEFAULT 1                -- 1 = offer it as a place at the desk
);

-- First aid roster. Editable in the app under Programme.
CREATE TABLE aiders (
  id    TEXT PRIMARY KEY,
  date  TEXT NOT NULL,                   -- YYYY-MM-DD
  start TEXT NOT NULL,                   -- HH:MM
  end   TEXT NOT NULL,                   -- HH:MM; '00:00' means midnight
  who   TEXT NOT NULL
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
INSERT INTO meta (k, v) VALUES ('rev', '1');

-- ---------------------------------------------------------------------------
-- The programme, straight off the 2026 Branch Moot schedule.
-- ---------------------------------------------------------------------------

-- Friday 2 October 2026
INSERT INTO activities (id, name, loc, date, start, end, kind, site, dest) VALUES
 ('fri-campsite-opens',  'Campsite Opens',              '',            '2026-10-02', '17:00', '17:30', 'camp',   'on',  0),
 ('fri-check-in',        'Check-in',                    '',            '2026-10-02', '17:30', '20:00', 'camp',   'on',  0),
 ('fri-mini-briefing',   'Mini-Briefing (Ethan and Nikki)', 'Scout Hall', '2026-10-02', '20:00', '20:30', 'main', 'on',  1),
 ('fri-dry-zone-ends',   'Moonta Hall Dry Zone Ends',   'Moonta Hall', '2026-10-02', '20:30', '21:00', 'cater',  'on',  0),
 ('fri-supper',          'Supper',                      'Scout Hall',  '2026-10-02', '21:00', '21:30', 'meal',   'on',  1),
 ('fri-quiet-hours',     'Quiet Hours Start',           '',            '2026-10-02', '22:00', '22:30', 'camp',   'on',  0);

-- Saturday 3 October 2026
INSERT INTO activities (id, name, loc, date, start, end, kind, site, dest) VALUES
 ('sat-dry-zone',           'Moonta Hall Dry Zone In Place', 'Moonta Hall',     '2026-10-03', '06:00', '06:30', 'cater',  'on',  0),
 ('sat-sunrise-walk',       'Sunrise Walk (unofficial)',     '',                '2026-10-03', '06:30', '07:00', 'main',   'off', 1),
 ('sat-breakfast-prep',     'Breakfast Preparation',         '',                '2026-10-03', '06:30', '08:00', 'cater',  'on',  0),
 ('sat-breakfast',          'Breakfast',                     '',                '2026-10-03', '08:00', '08:30', 'meal',   'on',  1),
 ('sat-breakfast-clean',    'Breakfast Clean-Up',            '',                '2026-10-03', '08:30', '10:00', 'cater',  'on',  0),
 ('sat-briefing',           'Morning Briefing / Event Open', '',                '2026-10-03', '09:00', '09:30', 'main',   'on',  1),
 ('sat-wide-game',          'Wide Game Site Open',           '',                '2026-10-03', '10:00', '17:00', 'onsite', 'on',  1),
 ('sat-scavenger-intro',    'Scavenger Hunt Introduction (Nikki)', '',          '2026-10-03', '10:00', '10:30', 'extra',  'on',  1),
 ('sat-damper-1',           'Damper Making #1',              '',                '2026-10-03', '10:00', '11:00', 'onsite', 'on',  1),
 ('sat-op-shop-1',          'Op Shop Crawl (groups 1 + 2)',  'Moonta op shops', '2026-10-03', '10:00', '12:30', 'main',   'off', 1),
 ('sat-op-shop-2',          'Op Shop Crawl (groups 3 + 4)',  'Moonta op shops', '2026-10-03', '10:30', '13:00', 'main',   'off', 1),
 ('sat-morning-tea-prep',   'Morning Tea Preparation',       '',                '2026-10-03', '10:30', '11:00', 'cater',  'on',  0),
 ('sat-morning-tea',        'Morning Tea',                   '',                '2026-10-03', '11:00', '11:30', 'meal',   'on',  1),
 ('sat-morning-tea-clean',  'Morning Tea Clean-Up',          '',                '2026-10-03', '11:30', '12:00', 'cater',  'on',  0),
 ('sat-damper-2',           'Damper Making #2',              '',                '2026-10-03', '12:00', '13:00', 'onsite', 'on',  1),
 ('sat-lunch-prep',         'Lunch Preparation',             '',                '2026-10-03', '12:00', '13:00', 'cater',  'on',  0),
 ('sat-lunch',              'Lunch',                         '',                '2026-10-03', '13:00', '13:30', 'meal',   'on',  1),
 ('sat-lunch-clean',        'Lunch Clean-Up',                '',                '2026-10-03', '13:30', '14:00', 'cater',  'on',  0),
 ('sat-bike-hike',          'Bike Hike (Lincoln)',           '',                '2026-10-03', '14:00', '17:00', 'main',   'off', 1),
 ('sat-swimming',           'Swimming',                      'Moonta Bay',      '2026-10-03', '14:00', '16:00', 'extra',  'off', 1),
 ('sat-damper-3',           'Damper Making #3',              '',                '2026-10-03', '14:00', '15:00', 'onsite', 'on',  1),
 ('sat-afternoon-tea-prep', 'Afternoon Tea Preparation',     '',                '2026-10-03', '15:00', '15:30', 'cater',  'on',  0),
 ('sat-afternoon-tea',      'Afternoon Tea',                 '',                '2026-10-03', '15:30', '16:00', 'meal',   'on',  1),
 ('sat-damper-4',           'Damper Making #4',              '',                '2026-10-03', '16:30', '17:30', 'onsite', 'on',  1),
 ('sat-frisbee',            'Frisbee',                       '',                '2026-10-03', '17:00', '18:30', 'extra',  'on',  1),
 ('sat-wide-game-organised','Organised Wide Game (to confirm)', '',             '2026-10-03', '17:30', '18:30', 'onsite', 'on',  1),
 ('sat-dinner-prep',        'Dinner Preparation',            '',                '2026-10-03', '17:00', '19:00', 'cater',  'on',  0),
 ('sat-dinner',             'Dinner',                        '',                '2026-10-03', '19:00', '19:30', 'meal',   'on',  1),
 ('sat-dinner-clean',       'Dinner Clean-Up',               '',                '2026-10-03', '19:30', '21:00', 'cater',  'on',  0),
 ('sat-dry-zone-ends',      'Moonta Hall Dry Zone Ends',     'Moonta Hall',     '2026-10-03', '20:00', '20:30', 'cater',  'on',  0),
 ('sat-bingo',              'The Main Event: Op Shop Bingo', '',                '2026-10-03', '20:00', '22:00', 'main',   'on',  1),
 ('sat-quiet-hours',        'Quiet Hours Start',             '',                '2026-10-03', '22:00', '22:30', 'camp',   'on',  0);

-- Sunday 4 October 2026
INSERT INTO activities (id, name, loc, date, start, end, kind, site, dest) VALUES
 ('sun-dry-zone',           'Moonta Hall Dry Zone In Place', 'Moonta Hall', '2026-10-04', '06:00', '06:30', 'cater',  'on',  0),
 ('sun-sunrise-walk',       'Sunrise Walk (unofficial)',     '',            '2026-10-04', '06:30', '07:00', 'main',   'off', 1),
 ('sun-breakfast-prep',     'Breakfast Preparation',         '',            '2026-10-04', '06:30', '08:00', 'cater',  'on',  0),
 ('sun-breakfast',          'Breakfast',                     '',            '2026-10-04', '08:00', '08:30', 'meal',   'on',  1),
 ('sun-breakfast-clean',    'Breakfast Clean-Up',            '',            '2026-10-04', '08:30', '10:00', 'cater',  'on',  0),
 ('sun-swimming',           'Swimming Open',                 'Moonta Bay',  '2026-10-04', '09:00', '11:00', 'main',   'off', 1),
 ('sun-walking-hike',       'Walking Hike (Amy)',            '',            '2026-10-04', '09:00', '11:00', 'extra',  'off', 1),
 ('sun-wide-game',          'Wide Game Site Open',           '',            '2026-10-04', '09:00', '17:00', 'onsite', 'on',  1),
 ('sun-markets',            'Queen Square Markets',          'Moonta',      '2026-10-04', '10:00', '15:00', 'main',   'off', 1),
 ('sun-damper-1',           'Damper Making #1',              '',            '2026-10-04', '10:00', '11:00', 'onsite', 'on',  1),
 ('sun-morning-tea-prep',   'Morning Tea Preparation',       '',            '2026-10-04', '10:30', '11:00', 'cater',  'on',  0),
 ('sun-morning-tea',        'Morning Tea',                   '',            '2026-10-04', '11:00', '11:30', 'meal',   'on',  1),
 ('sun-morning-tea-clean',  'Morning Tea Clean-Up',          '',            '2026-10-04', '11:30', '12:00', 'cater',  'on',  0),
 ('sun-damper-2',           'Damper Making #2',              '',            '2026-10-04', '12:00', '13:00', 'onsite', 'on',  1),
 ('sun-lunch-prep',         'Lunch Preparation',             '',            '2026-10-04', '12:00', '13:00', 'cater',  'on',  0),
 ('sun-lunch',              'Lunch',                         '',            '2026-10-04', '13:00', '13:30', 'meal',   'on',  1),
 ('sun-lunch-clean',        'Lunch Clean-Up',                '',            '2026-10-04', '13:30', '14:00', 'cater',  'on',  0),
 ('sun-catapult-1',         'Catapult Competition #1',       '',            '2026-10-04', '14:00', '16:30', 'main',   'on',  1),
 ('sun-distillery',         'Sunny Hill Distillery',         '',            '2026-10-04', '14:00', '16:00', 'extra',  'off', 1),
 ('sun-afternoon-tea-prep', 'Afternoon Tea Preparation',     '',            '2026-10-04', '15:00', '15:30', 'cater',  'on',  0),
 ('sun-afternoon-tea',      'Afternoon Tea',                 '',            '2026-10-04', '15:30', '16:00', 'meal',   'on',  1),
 ('sun-brewery',            'HendonBar Brewing',             '',            '2026-10-04', '15:30', '17:30', 'extra',  'off', 1),
 ('sun-dinner-prep',        'Dinner Preparation',            '',            '2026-10-04', '17:00', '19:00', 'cater',  'on',  0),
 ('sun-dinner',             'Dinner',                        '',            '2026-10-04', '19:00', '19:30', 'meal',   'on',  1),
 ('sun-dinner-clean',       'Dinner Clean-Up',               '',            '2026-10-04', '19:30', '21:00', 'cater',  'on',  0),
 ('sun-dry-zone-ends',      'Moonta Hall Dry Zone Ends',     'Moonta Hall', '2026-10-04', '20:00', '20:30', 'cater',  'on',  0),
 ('sun-movie-night',        'Movie Night',                   '',            '2026-10-04', '20:00', '21:30', 'main',   'on',  1),
 ('sun-catapult-2',         'Catapult Competition #2',       '',            '2026-10-04', '20:00', '22:00', 'extra',  'on',  1),
 ('sun-quiet-hours',        'Quiet Hours Start',             '',            '2026-10-04', '22:00', '22:30', 'camp',   'on',  0);

-- Monday 5 October 2026
INSERT INTO activities (id, name, loc, date, start, end, kind, site, dest) VALUES
 ('mon-dry-zone',        'Moonta Hall Dry Zone In Place', 'Moonta Hall', '2026-10-05', '06:00', '06:30', 'cater', 'on',  0),
 ('mon-sunrise-walk',    'Sunrise Walk (unofficial)',     '',            '2026-10-05', '06:30', '07:00', 'main',  'off', 1),
 ('mon-breakfast-prep',  'Breakfast Preparation',         '',            '2026-10-05', '06:30', '08:00', 'cater', 'on',  0),
 ('mon-breakfast',       'Breakfast',                     '',            '2026-10-05', '08:00', '08:30', 'meal',  'on',  1),
 ('mon-breakfast-clean', 'Breakfast Clean-Up',            '',            '2026-10-05', '08:30', '09:00', 'cater', 'on',  0),
 ('mon-capture-flag',    'Capture the Flag',              '',            '2026-10-05', '10:00', '11:00', 'main',  'on',  1),
 ('mon-lunch',           'Lunch',                         '',            '2026-10-05', '12:00', '12:30', 'meal',  'on',  1),
 ('mon-closing',         'Closing Ceremony',              '',            '2026-10-05', '13:00', '13:30', 'main',  'on',  1),
 ('mon-campsite-closes', 'Campsite Closes',               '',            '2026-10-05', '15:00', '15:30', 'camp',  'on',  0);

-- ---------------------------------------------------------------------------
-- First aid roster, from the same sheet. '00:00' as an end time means midnight.
-- ---------------------------------------------------------------------------
INSERT INTO aiders (id, date, start, end, who) VALUES
 ('aid-fri-1', '2026-10-02', '06:00', '19:00', 'Jordan and Victor'),
 ('aid-fri-2', '2026-10-02', '19:00', '21:00', 'Bella and Heidi'),
 ('aid-fri-3', '2026-10-02', '21:00', '21:30', 'Bella and Scott'),
 ('aid-fri-4', '2026-10-02', '21:30', '00:00', 'Bella and Heidi'),
 ('aid-sat-1', '2026-10-03', '00:00', '07:00', 'Ethan (overnight)'),
 ('aid-sat-2', '2026-10-03', '07:00', '13:00', 'Bella'),
 ('aid-sat-3', '2026-10-03', '13:00', '19:00', 'Victor'),
 ('aid-sat-4', '2026-10-03', '19:00', '00:00', 'Ethan and Heidi'),
 ('aid-sun-1', '2026-10-04', '00:00', '07:00', 'Jordan (overnight)'),
 ('aid-sun-2', '2026-10-04', '07:00', '13:00', 'Heidi'),
 ('aid-sun-3', '2026-10-04', '13:00', '19:00', 'Ethan'),
 ('aid-sun-4', '2026-10-04', '19:00', '00:00', 'Jordan and Victor'),
 ('aid-mon-1', '2026-10-05', '00:00', '07:00', 'Bella (overnight)'),
 ('aid-mon-2', '2026-10-05', '07:00', '13:00', 'Victor'),
 ('aid-mon-3', '2026-10-05', '13:00', '19:00', 'Jordan');
