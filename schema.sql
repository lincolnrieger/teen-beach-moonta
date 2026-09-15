-- Teen Beach Moonta — camp check in database (Cloudflare D1)
-- Apply with:  npx wrangler d1 execute teenbeach --remote --file=./schema.sql

DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS movements;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS meta;

CREATE TABLE members (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  crew    TEXT,
  state   TEXT NOT NULL DEFAULT 'in',   -- 'in' on site, 'out' away
  act     TEXT,                          -- activity id they signed out to
  since   INTEGER,                       -- ms timestamp of last change
  created INTEGER
);

CREATE TABLE movements (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  dir  TEXT NOT NULL,                    -- 'out' or 'in'
  act  TEXT,
  t    INTEGER NOT NULL
);
CREATE INDEX movements_t ON movements (t DESC);

CREATE TABLE activities (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  loc   TEXT,
  date  TEXT NOT NULL,                   -- YYYY-MM-DD
  start TEXT NOT NULL,                   -- HH:MM
  end   TEXT NOT NULL,
  kind  TEXT DEFAULT 'main',             -- main | meal | cater | camp
  dest  INTEGER DEFAULT 1                -- 1 = offer it as a destination at the desk
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
INSERT INTO meta (k, v) VALUES ('rev', '1');

-- Monday 5 October 2026, straight from the programme spreadsheet
INSERT INTO activities (id, name, loc, date, start, end, kind, dest) VALUES
 ('mon-dry-zone',        'Moonta Hall Dry Zone In Place', '', '2026-10-05', '06:00', '06:30', 'cater', 0),
 ('mon-sunrise-walk',    'Sunrise Walk (unofficial)',     '', '2026-10-05', '06:30', '07:00', 'main',  1),
 ('mon-breakfast-prep',  'Breakfast Preparation',         '', '2026-10-05', '06:30', '08:00', 'cater', 0),
 ('mon-breakfast',       'Breakfast',                     '', '2026-10-05', '08:00', '08:30', 'meal',  0),
 ('mon-breakfast-clean', 'Breakfast Clean-Up',            '', '2026-10-05', '08:30', '09:00', 'cater', 0),
 ('mon-capture-flag',    'Capture the Flag',              '', '2026-10-05', '10:00', '11:00', 'main',  1),
 ('mon-lunch',           'Lunch',                         '', '2026-10-05', '12:00', '12:30', 'meal',  0),
 ('mon-closing',         'Closing Ceremony',              '', '2026-10-05', '13:00', '13:30', 'main',  1),
 ('mon-campsite-closes', 'Campsite Closes',               '', '2026-10-05', '15:00', '15:30', 'camp',  0);
