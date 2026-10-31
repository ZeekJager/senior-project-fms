import { describe, expect, it } from 'vitest'
import { currentMonth, markOf, monthBounds, monthLabel, readState, shiftMonth, writeState, type ReconciliationRow } from './api'
import { anomalyPeriod, anomalyTitle, csvRow, signedPct } from './describe'

const row = (overrides: Partial<ReconciliationRow> = {}): ReconciliationRow => ({
  vehicle_id: 'v-1',
  registration_number: 'AA 3-12345',
  depot_name: 'Bole, Addis Ababa',
  depot_id: 'd-1',
  fuel_type: 'diesel',
  fuel_efficiency_ml_per_km: 320,
  distance_km: 1000.5,
  trips: 2,
  fuel_logs: 3,
  expected_ml: 320_160,
  actual_ml: 400_205,
  variance_ml: 80_045,
  variance_pct: 25,
  total_cost_cents: 3_800_050,
  status: 'above',
  reason: null,
  anomaly_id: null,
  ...overrides,
})

describe('marks (FMS-42)', () => {
  it('beyond the threshold either way is a flag, beyond half of it a watch, the rest OK', () => {
    expect(markOf(row({ variance_pct: 25 }), 20)).toBe('flag')
    expect(markOf(row({ variance_pct: -21 }), 20)).toBe('flag')
    expect(markOf(row({ variance_pct: 20 }), 20)).toBe('watch')
    expect(markOf(row({ variance_pct: -11 }), 20)).toBe('watch')
    expect(markOf(row({ variance_pct: 10 }), 20)).toBe('ok')
    expect(markOf(row({ variance_pct: 0 }), 20)).toBe('ok')
    expect(markOf(row({ status: 'not_judged', variance_pct: null }), 20)).toBe('not_judged')
    // The threshold is the server's (FUEL_VARIANCE_THRESHOLD_PCT).
    expect(markOf(row({ variance_pct: 12 }), 10)).toBe('flag')
  })

  it('says percentages with their sign and a true minus', () => {
    expect(signedPct(25)).toBe('+25%')
    expect(signedPct(-30)).toBe('−30%')
    expect(signedPct(0)).toBe('0%')
    expect(signedPct(null)).toBe('—')
  })
})

describe('months', () => {
  it('steps across years, bounds a month by its days, names it', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(monthLabel('2026-09')).toBe('September 2026')
  })

  it('is this month in Addis Ababa, three hours ahead of UTC', () => {
    expect(currentMonth(new Date('2026-09-30T21:30:00Z'))).toBe('2026-10')
  })

  it('defaults to last month and never a month not yet begun; the defaults stay out of the URL', () => {
    const now = new Date('2026-10-29T08:00:00Z')
    expect(readState(new URLSearchParams(), now)).toEqual({ tab: 'vehicles', month: '2026-09', depotId: '', mark: '', anomalyView: 'needs_review', anomaly: '' })
    expect(readState(new URLSearchParams('month=2026-11'), now).month).toBe('2026-09')
    expect(readState(new URLSearchParams('month=2026-10&tab=anomalies&view=all&mark=flag'), now)).toMatchObject({ month: '2026-10', tab: 'anomalies', anomalyView: 'all', mark: 'flag' })
    expect(writeState(readState(new URLSearchParams(), now), now).toString()).toBe('')
    expect(writeState({ ...readState(new URLSearchParams(), now), month: '2026-08', mark: 'watch' }, now).toString()).toBe('month=2026-08&mark=watch')
  })
})

describe('anomalies and the export', () => {
  it('names an anomaly by what was found and its month', () => {
    expect(anomalyTitle({ anomaly_type: 'consumption_above_expected', deviation_pct: 25 })).toBe('Fuel 25% over expected')
    expect(anomalyTitle({ anomaly_type: 'consumption_below_expected', deviation_pct: -30 })).toBe('Fuel 30% under expected')
    expect(anomalyTitle({ anomaly_type: 'tank_overfill', deviation_pct: null })).toBe('Tank overfill')
    expect(anomalyPeriod({ period_from: '2026-08-31T21:00:00.000Z' })).toBe('September 2026')
  })

  it('exports litres to the millilitre and birr to the cent, from the integers, ungrouped', () => {
    expect(csvRow(row(), 20)).toEqual(['AA 3-12345', 'Bole, Addis Ababa', 'diesel', 320, 1000.5, 2, 3, '320.160', '400.205', '80.045', 25, '38000.50', 'Flag', ''])
    expect(csvRow(row({ status: 'not_judged', reason: 'too_little_distance', expected_ml: null, variance_ml: null, variance_pct: null }), 20).slice(7)).toEqual([
      '',
      '400.205',
      '',
      null,
      '38000.50',
      'Not judged',
      'Under 100 km of trips',
    ])
  })
})
