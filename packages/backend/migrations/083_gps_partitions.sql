-- =====================================================================
-- 083_gps_partitions.sql
-- GPS partition maintenance (FMS-110, docs/gps-ingestion.md#partitions).
--
-- tracking.gps_pings has been partitioned by recorded_at since 007, with
-- only its default partition. From here on it has one partition a month
-- (UTC months, tracking.gps_pings_yYYYYmMM):
--
-- * tracking.ensure_gps_partitions(as_of, months_ahead) makes the month of
--   as_of and the months_ahead after it, and a month for every month that
--   has rows in the default partition, which it moves there. Run nightly
--   by the gps-partitions job, and once here.
-- * tracking.drop_gps_partitions_before(cutoff) detaches and drops every
--   month that ended at or before cutoff: retention (FMS-104) as a drop
--   instead of millions of deletes. The tracking-retention job calls it
--   before deleting what is left of the month the cutoff falls in.
-- * tracking.gps_partitions() lists the months; gps_partition_status()
--   says how far ahead they reach and how many rows are in the default
--   partition (the metrics behind the GpsPartitionMissing alert).
--
-- The runtime role does not own the table, and only its owner may add or
-- drop partitions: the two maintenance functions are SECURITY DEFINER,
-- owned by the schema owner, executable by fms_app and nobody else.
-- =====================================================================

-- +migrate Up

-- The monthly partitions and their bounds, read from the catalog.
CREATE OR REPLACE FUNCTION tracking.gps_partitions()
RETURNS TABLE (partition_name TEXT, range_start TIMESTAMPTZ, range_end TIMESTAMPTZ)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT c.relname::text,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), $re$FROM \('([^']+)'\)$re$))[1]::timestamptz,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), $re$TO \('([^']+)'\)$re$))[1]::timestamptz
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'tracking.gps_pings'::regclass
       AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
     ORDER BY 2
$$;

CREATE OR REPLACE FUNCTION tracking.ensure_gps_partitions(as_of TIMESTAMPTZ, months_ahead INTEGER DEFAULT 2)
RETURNS TABLE (partition_name TEXT, range_start TIMESTAMPTZ, rows_moved BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
    month_start TIMESTAMPTZ;
    month_end   TIMESTAMPTZ;
    name        TEXT;
    columns     TEXT;
    moved       BIGINT;
BEGIN
    IF months_ahead IS NULL OR months_ahead < 1 OR months_ahead > 12 THEN
        RAISE EXCEPTION 'months_ahead must be between 1 and 12 (is %)', months_ahead;
    END IF;

    -- Inserts keep going to the monthly partitions; only rows outside every month (in the default partition)
    -- wait while a month is made, so none can land in a month between its move and its attach.
    LOCK TABLE tracking.gps_pings IN SHARE UPDATE EXCLUSIVE MODE;
    LOCK TABLE tracking.gps_pings_default IN ACCESS EXCLUSIVE MODE;

    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO columns
      FROM pg_attribute a
     WHERE a.attrelid = 'tracking.gps_pings'::regclass AND a.attnum > 0 AND NOT a.attisdropped;

    FOR month_start IN
        SELECT m FROM (
            SELECT DISTINCT date_trunc('month', d.recorded_at) AS m FROM tracking.gps_pings_default d
            UNION
            SELECT generate_series(date_trunc('month', as_of), date_trunc('month', as_of) + make_interval(months => months_ahead), interval '1 month')
        ) months
        WHERE NOT EXISTS (SELECT 1 FROM tracking.gps_partitions() p WHERE p.range_start <= months.m AND p.range_end > months.m)
        ORDER BY m
    LOOP
        month_end := month_start + interval '1 month';
        name := 'gps_pings_y' || to_char(month_start, 'YYYY') || 'm' || to_char(month_start, 'MM');
        EXECUTE format('CREATE TABLE tracking.%I (LIKE tracking.gps_pings INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', name);
        -- The bound as a constraint first: attaching then need not read the month again.
        EXECUTE format('ALTER TABLE tracking.%I ADD CONSTRAINT %I CHECK (recorded_at >= %L AND recorded_at < %L)',
                       name, name || '_bound', month_start, month_end);
        EXECUTE format('WITH moved AS (DELETE FROM tracking.gps_pings_default WHERE recorded_at >= $1 AND recorded_at < $2 RETURNING %s)
                        INSERT INTO tracking.%I (%s) SELECT %s FROM moved', columns, name, columns, columns)
            USING month_start, month_end;
        GET DIAGNOSTICS moved = ROW_COUNT;
        EXECUTE format('ALTER TABLE tracking.gps_pings ATTACH PARTITION tracking.%I FOR VALUES FROM (%L) TO (%L)', name, month_start, month_end);
        EXECUTE format('ALTER TABLE tracking.%I DROP CONSTRAINT %I', name, name || '_bound');

        partition_name := name;
        range_start := month_start;
        rows_moved := moved;
        RETURN NEXT;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION tracking.drop_gps_partitions_before(cutoff TIMESTAMPTZ)
RETURNS TABLE (partition_name TEXT, range_start TIMESTAMPTZ, range_end TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
    p RECORD;
BEGIN
    -- Retention is at least 30 days (GPS_PING_RETENTION_DAYS): a cutoff in the future is a mistake, not a policy.
    IF cutoff IS NULL OR cutoff > now() THEN
        RAISE EXCEPTION 'cutoff must be in the past (is %)', cutoff;
    END IF;
    FOR p IN SELECT * FROM tracking.gps_partitions() g WHERE g.range_end <= cutoff ORDER BY g.range_start LOOP
        EXECUTE format('ALTER TABLE tracking.gps_pings DETACH PARTITION tracking.%I', p.partition_name);
        EXECUTE format('DROP TABLE tracking.%I', p.partition_name);
        partition_name := p.partition_name;
        range_start := p.range_start;
        range_end := p.range_end;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- How far ahead the months reach, how many there are, and how many rows are outside them (counted up to a million).
CREATE OR REPLACE FUNCTION tracking.gps_partition_status()
RETURNS TABLE (covered_until TIMESTAMPTZ, partitions INTEGER, default_rows BIGINT)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT (SELECT max(g.range_end) FROM tracking.gps_partitions() g),
           (SELECT count(*)::int FROM tracking.gps_partitions()),
           (SELECT count(*) FROM (SELECT 1 FROM tracking.gps_pings_default LIMIT 1000000) d)
$$;

REVOKE ALL ON FUNCTION tracking.ensure_gps_partitions(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracking.drop_gps_partitions_before(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracking.gps_partition_status() FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT EXECUTE ON FUNCTION tracking.ensure_gps_partitions(TIMESTAMPTZ, INTEGER) TO fms_app;
        GRANT EXECUTE ON FUNCTION tracking.drop_gps_partitions_before(TIMESTAMPTZ) TO fms_app;
        GRANT EXECUTE ON FUNCTION tracking.gps_partition_status() TO fms_app;
        GRANT EXECUTE ON FUNCTION tracking.gps_partitions() TO fms_app;
    END IF;
END $$;

-- This month and the two after it, and the rows already stored, each moved into its month.
SELECT count(*) FROM tracking.ensure_gps_partitions(now(), 2);

-- +migrate Down

-- Every month's rows back into the default partition, then the months and the functions gone.
DO $$
DECLARE
    p RECORD;
    columns TEXT;
BEGIN
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO columns
      FROM pg_attribute a
     WHERE a.attrelid = 'tracking.gps_pings'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    FOR p IN SELECT * FROM tracking.gps_partitions() LOOP
        EXECUTE format('ALTER TABLE tracking.gps_pings DETACH PARTITION tracking.%I', p.partition_name);
        EXECUTE format('INSERT INTO tracking.gps_pings_default (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM tracking.%I', columns, columns, p.partition_name);
        EXECUTE format('DROP TABLE tracking.%I', p.partition_name);
    END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS tracking.gps_partition_status();
DROP FUNCTION IF EXISTS tracking.drop_gps_partitions_before(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS tracking.ensure_gps_partitions(TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS tracking.gps_partitions();
