-- =====================================================================
-- 017_fleet_driver_accounts.sql
-- A fleet-owned copy of the account fields drivers are listed by (FMS-16).
--
-- A driver's name, email and home depot live on their user account (auth).
-- Fleet SQL may not read auth tables (FMS-12), so to filter, search and
-- sort drivers by them in one query, fleet keeps this read model. It is
-- derived data, like analytics_cache: not audited, and rebuilt from the
-- accounts by the fleet module (same transaction when fleet changes an
-- account, an event when another module does, and a daily re-sync that
-- repairs anything missed).
--
-- The backfill below reads auth.users once, as a migration; application
-- code never does.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS fleet.driver_accounts (
    user_id         BIGINT PRIMARY KEY REFERENCES auth.users(id)
                    ON DELETE CASCADE ON UPDATE CASCADE,
    full_name       VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    depot_id        BIGINT REFERENCES fleet.depots(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    account_status  shared.user_status NOT NULL,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fleet_driver_accounts_depot
    ON fleet.driver_accounts(depot_id);

INSERT INTO fleet.driver_accounts (user_id, full_name, email, depot_id, account_status)
SELECT u.id, u.full_name, u.email, u.depot_id, u.status
  FROM fleet.drivers d
  JOIN auth.users u ON u.id = d.user_id
ON CONFLICT (user_id) DO NOTHING;

-- +migrate Down

DROP INDEX IF EXISTS fleet.idx_fleet_driver_accounts_depot;
DROP TABLE IF EXISTS fleet.driver_accounts;
