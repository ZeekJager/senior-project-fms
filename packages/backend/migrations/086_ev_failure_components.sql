-- =====================================================================
-- 086_ev_failure_components.sql
-- The EV failure components (FMS-134, docs/ml-dataset.md#ev).
--
-- maintenance.failure_component (FMS-125, migration 036) gains what an
-- electric vehicle fails in: traction_battery (the pack), motor_inverter,
-- charging_system (on-board charger and inlet) and thermal_management (the
-- battery and motor thermal loop). The EV predictive maintenance model's
-- label names them (feature_spec_ev.json). Failure events, prediction
-- feedback and warranties take them as every other component.
-- =====================================================================

-- +migrate Up

ALTER TYPE maintenance.failure_component ADD VALUE IF NOT EXISTS 'traction_battery';
ALTER TYPE maintenance.failure_component ADD VALUE IF NOT EXISTS 'motor_inverter';
ALTER TYPE maintenance.failure_component ADD VALUE IF NOT EXISTS 'charging_system';
ALTER TYPE maintenance.failure_component ADD VALUE IF NOT EXISTS 'thermal_management';

-- +migrate Down

-- An enum value cannot be dropped: the type is made again without them. A record naming one keeps its place as other.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'maintenance' AND t.typname = 'failure_component' AND e.enumlabel = 'traction_battery') THEN
        UPDATE maintenance.failure_events SET component = 'other'
         WHERE component::text IN ('traction_battery', 'motor_inverter', 'charging_system', 'thermal_management');
        UPDATE maintenance.prediction_feedback SET component = 'other'
         WHERE component::text IN ('traction_battery', 'motor_inverter', 'charging_system', 'thermal_management');
        UPDATE maintenance.warranties SET component = 'other'
         WHERE component::text IN ('traction_battery', 'motor_inverter', 'charging_system', 'thermal_management');
        -- The reports' views read the column (migration 082): made again after it, as 082 makes them.
        DROP VIEW IF EXISTS analytics.report_failures;
        DROP VIEW IF EXISTS analytics.report_maintenance;
        ALTER TYPE maintenance.failure_component RENAME TO failure_component_ev;
        CREATE TYPE maintenance.failure_component AS ENUM
            ('engine', 'cooling', 'brakes', 'tyres', 'transmission', 'electrical', 'suspension',
             'steering', 'fuel_system', 'exhaust', 'body', 'other');
        ALTER TABLE maintenance.failure_events
            ALTER COLUMN component TYPE maintenance.failure_component USING component::text::maintenance.failure_component;
        ALTER TABLE maintenance.prediction_feedback
            ALTER COLUMN component TYPE maintenance.failure_component USING component::text::maintenance.failure_component;
        ALTER TABLE maintenance.warranties
            ALTER COLUMN component TYPE maintenance.failure_component USING component::text::maintenance.failure_component;
        DROP TYPE maintenance.failure_component_ev;
        CREATE OR REPLACE VIEW analytics.report_failures AS
        SELECT fe.id AS failure_id, fe.vehicle_id, fe.component::text AS component, fe.unplanned, fe.occurred_at, fe.maintenance_record_id
          FROM maintenance.failure_events fe;
        CREATE OR REPLACE VIEW analytics.report_maintenance AS
        SELECT m.id AS record_id, m.vehicle_id, m.maintenance_type::text AS maintenance_type, m.status::text AS status, m.created_at,
               m.scheduled_at, m.completed_at, m.labor_hours, m.total_cost_cents, NULLIF(btrim(m.workshop), '') AS workshop, m.service_program_id,
               (SELECT fe.component::text FROM maintenance.failure_events fe WHERE fe.maintenance_record_id = m.id ORDER BY fe.occurred_at LIMIT 1) AS component
          FROM maintenance.maintenance_records m;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
            GRANT SELECT ON analytics.report_failures, analytics.report_maintenance TO fms_app;
        END IF;
    END IF;
END $$;
