import { describe, expect, test } from 'vitest';
import { LICENSE_CATEGORIES, LICENSE_CATEGORY_VEHICLE_TYPES, categoryAllows } from './driver';
import { VEHICLE_TYPES } from './vehicle';

describe('licence classes', () => {
  test('a class allows exactly its vehicle types', () => {
    expect(categoryAllows('automobile', 'car')).toBe(true);
    expect(categoryAllows('automobile', 'truck')).toBe(false);
    expect(categoryAllows('public_3', 'bus')).toBe(true);
    expect(categoryAllows('motorcycle', 'car')).toBe(false);
    expect(categoryAllows('dry_cargo_2', 'truck')).toBe(true);
    expect(categoryAllows('special', 'other')).toBe(true);
    expect(categoryAllows('not-a-class', 'car')).toBe(false);
  });

  test('every vehicle type can be driven with some class', () => {
    for (const type of VEHICLE_TYPES) {
      expect(LICENSE_CATEGORIES.some((c) => categoryAllows(c, type)), type).toBe(true);
    }
    expect(Object.keys(LICENSE_CATEGORY_VEHICLE_TYPES)).toEqual(LICENSE_CATEGORIES);
  });
});
