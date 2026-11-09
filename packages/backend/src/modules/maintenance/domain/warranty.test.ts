import { describe, expect, test } from 'vitest';
import { coveringWarranty, covers, operatingDay, recallMatches, warrantyStatus, type WarrantyTerms } from './warranty';

const w = (overrides: Partial<WarrantyTerms> = {}): WarrantyTerms => ({
  id: '1',
  component: null,
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  endsKm: null,
  isActive: true,
  ...overrides,
});

describe('covers', () => {
  const repair = { workDay: '2026-06-01', odometerKm: 50_000, components: ['brakes'] as const };

  test('on its work day, from the start to the end date, both days included', () => {
    expect(covers(w(), repair)).toBe(true);
    expect(covers(w({ startsOn: '2026-06-01', endsOn: '2026-06-01' }), repair)).toBe(true);
    expect(covers(w({ startsOn: '2026-06-02' }), repair)).toBe(false);
    expect(covers(w({ endsOn: '2026-05-31' }), repair)).toBe(false);
  });

  test('within its end odometer; a repair without an odometer is not judged on it', () => {
    expect(covers(w({ endsKm: 50_000 }), repair)).toBe(true);
    expect(covers(w({ endsKm: 49_999.9 }), repair)).toBe(false);
    expect(covers(w({ endsKm: 1 }), { ...repair, odometerKm: null })).toBe(true);
    expect(covers(w({ endsOn: null, endsKm: 60_000 }), repair)).toBe(true);
  });

  test('the whole vehicle or a component that failed; nothing failed, nothing covered; void covers nothing', () => {
    expect(covers(w({ component: 'brakes' }), repair)).toBe(true);
    expect(covers(w({ component: 'engine' }), repair)).toBe(false);
    expect(covers(w(), { ...repair, components: [] })).toBe(false);
    expect(covers(w({ isActive: false }), repair)).toBe(false);
  });
});

describe('coveringWarranty', () => {
  const repair = { workDay: '2026-06-01', odometerKm: null, components: ['brakes', 'engine'] as const };

  test('the component cover before the whole vehicle, then the one ending last, then the oldest', () => {
    const whole = w({ id: '1', endsOn: '2030-01-01' });
    const brakes = w({ id: '2', component: 'brakes', endsOn: '2026-07-01' });
    const engine = w({ id: '3', component: 'engine', endsOn: '2027-01-01' });
    const engineToo = w({ id: '4', component: 'engine', endsOn: '2027-01-01' });
    expect(coveringWarranty([whole, brakes, engine, engineToo], repair)?.id).toBe('3');
    expect(coveringWarranty([whole, brakes], repair)?.id).toBe('2');
    expect(coveringWarranty([whole, w({ id: '5', endsOn: null, endsKm: 1 })], repair)?.id).toBe('5');
    expect(coveringWarranty([w({ component: 'tyres' })], repair)).toBeNull();
  });
});

describe('warrantyStatus', () => {
  test('not started, active, expiring within 30 days, expired by date or distance, void', () => {
    expect(warrantyStatus(w(), '2025-12-31', null)).toBe('not_started');
    expect(warrantyStatus(w(), '2026-06-01', null)).toBe('active');
    expect(warrantyStatus(w(), '2026-12-01', null)).toBe('expiring');
    expect(warrantyStatus(w(), '2026-11-30', null)).toBe('active');
    expect(warrantyStatus(w(), '2026-12-31', null)).toBe('expiring');
    expect(warrantyStatus(w(), '2027-01-01', null)).toBe('expired');
    expect(warrantyStatus(w({ endsKm: 100_000 }), '2026-06-01', 100_001)).toBe('expired');
    expect(warrantyStatus(w({ endsOn: null, endsKm: 100_000 }), '2026-06-01', null)).toBe('active');
    expect(warrantyStatus(w({ isActive: false }), '2026-06-01', null)).toBe('void');
    expect(warrantyStatus(w(), '2026-12-15', null, 10)).toBe('active');
  });
});

describe('recallMatches', () => {
  const recall = { make: 'Isuzu', model: 'FSR', yearFrom: 2018, yearTo: 2022 };

  test('make and model ignoring case and outer spaces, a model year in the range', () => {
    expect(recallMatches(recall, { make: ' isuzu', model: 'fsr ', modelYear: 2018 })).toBe(true);
    expect(recallMatches(recall, { make: 'Isuzu', model: 'FSR', modelYear: 2022 })).toBe(true);
    expect(recallMatches(recall, { make: 'Isuzu', model: 'FSR', modelYear: 2017 })).toBe(false);
    expect(recallMatches(recall, { make: 'Isuzu', model: 'FSR', modelYear: 2023 })).toBe(false);
    expect(recallMatches(recall, { make: 'Isuzu', model: 'NQR', modelYear: 2020 })).toBe(false);
    expect(recallMatches(recall, { make: 'Toyota', model: 'FSR', modelYear: 2020 })).toBe(false);
    expect(recallMatches(recall, { make: 'Isuzu', model: 'FSR', modelYear: null })).toBe(false);
  });
});

describe('operatingDay', () => {
  test('the Addis Ababa day: 21:00 UTC is already the next day there', () => {
    expect(operatingDay(new Date('2026-06-01T20:59:00Z'))).toBe('2026-06-01');
    expect(operatingDay(new Date('2026-06-01T21:00:00Z'))).toBe('2026-06-02');
  });
});
