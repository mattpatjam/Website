-- Raw Health Auto Export payloads, gzip-compressed and split into chunks
-- (D1 rows are capped at ~2 MB). sha256 makes re-sent payloads a no-op.
CREATE TABLE raw_payloads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256      TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  chunks      INTEGER NOT NULL,
  status      TEXT NOT NULL,          -- 'parsed' | 'error'
  summary     TEXT,                   -- JSON counts per metric
  error       TEXT
);

CREATE TABLE raw_payload_chunks (
  payload_id INTEGER NOT NULL REFERENCES raw_payloads(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (payload_id, idx)
);

-- Point / interval samples, normalised units:
--   resting_hr bpm, hrv ms (SDNN), spo2 %, steps count, active_kcal kcal,
--   heart_rate bpm (value = avg, with min/max), respiratory_rate /min
CREATE TABLE samples (
  metric     TEXT NOT NULL,
  ts         INTEGER NOT NULL,        -- unix seconds (UTC) of sample start
  local_date TEXT NOT NULL,           -- YYYY-MM-DD in the home timezone
  source     TEXT NOT NULL DEFAULT '',
  value      REAL NOT NULL,
  value_min  REAL,
  value_max  REAL,
  PRIMARY KEY (metric, ts, source)
) WITHOUT ROWID;
CREATE INDEX samples_by_date ON samples (metric, local_date);

-- One row per night when HAE sends summarised sleep ("Summarize data" on).
CREATE TABLE sleep_summaries (
  night_date     TEXT NOT NULL,       -- local date you woke up
  source         TEXT NOT NULL DEFAULT '',
  sleep_start_ts INTEGER,
  sleep_end_ts   INTEGER,
  in_bed_start_ts INTEGER,
  in_bed_end_ts  INTEGER,
  asleep_h REAL, in_bed_h REAL, deep_h REAL, core_h REAL, rem_h REAL, awake_h REAL,
  PRIMARY KEY (night_date, source)
);

-- Individual stage segments when HAE sends unsummarised sleep.
CREATE TABLE sleep_segments (
  start_ts   INTEGER NOT NULL,
  end_ts     INTEGER NOT NULL,
  stage      TEXT NOT NULL,           -- deep | core | rem | awake | asleep | inbed
  source     TEXT NOT NULL DEFAULT '',
  night_date TEXT NOT NULL,
  PRIMARY KEY (start_ts, stage, source)
);
CREATE INDEX sleep_segments_by_night ON sleep_segments (night_date);

CREATE TABLE workouts (
  id           TEXT PRIMARY KEY,      -- HAE id, or hash of name+start
  name         TEXT NOT NULL,
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER NOT NULL,
  local_date   TEXT NOT NULL,
  duration_min REAL NOT NULL,
  active_kcal  REAL,
  avg_hr       REAL,
  max_hr       REAL,
  distance_km  REAL,
  source       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX workouts_by_date ON workouts (local_date);

-- Tidy daily table, recomputed from the tables above (idempotent).
CREATE TABLE daily_metrics (
  date        TEXT PRIMARY KEY,
  sleep_h     REAL, in_bed_h REAL, deep_h REAL, core_h REAL, rem_h REAL, awake_h REAL,
  bed_ts      INTEGER, wake_ts INTEGER,
  resting_hr  REAL,
  hrv         REAL, hrv_n INTEGER,
  spo2        REAL, spo2_min REAL,
  steps       REAL,
  active_kcal REAL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE calendar_events (
  id          TEXT PRIMARY KEY,       -- calendarId:eventId
  calendar_id TEXT NOT NULL,
  summary     TEXT,
  location    TEXT,
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  all_day     INTEGER NOT NULL DEFAULT 0,
  start_date  TEXT NOT NULL,          -- local date of start (home tz)
  end_date    TEXT NOT NULL,          -- local date of end (inclusive)
  busy        INTEGER NOT NULL DEFAULT 1,  -- 0 for free/transparent/declined/working-location
  is_tennis   INTEGER NOT NULL DEFAULT 0,
  synced_at   TEXT NOT NULL
);
CREATE INDEX calendar_events_by_start ON calendar_events (start_ts);

CREATE TABLE oauth_tokens (
  provider      TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  access_token  TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE readiness (
  date        TEXT PRIMARY KEY,
  score       INTEGER,
  components  TEXT NOT NULL,          -- JSON
  limiter     TEXT,
  computed_at TEXT NOT NULL
);

CREATE TABLE recommendations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  model       TEXT NOT NULL,
  readiness   INTEGER,
  content     TEXT NOT NULL           -- JSON (see src/recs/claude.ts)
);
CREATE INDEX recommendations_by_date ON recommendations (date);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE job_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,           -- ingest | calendar | recompute | recs
  at         TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  message    TEXT
);
CREATE INDEX job_log_by_kind ON job_log (kind, id);

CREATE TABLE login_attempts (
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);
