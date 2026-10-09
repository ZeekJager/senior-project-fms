import { describe, expect, test } from 'vitest';
import { LICENSE_CATEGORIES, LICENSE_CATEGORY_VEHICLE_TYPES, categoryAllows, normalizeCategories } from './driver';
import { VEHICLE_TYPES } from './vehicle';

describe('European licence categories', () => {
  test('a vehicle is allowed when any held category allows its type', () => {
    expect(categoryAllows(['B'], 'car')).toBe(true);
    expect(categoryAllows(['B'], 'truck')).toBe(false);
    expect(categoryAllows(['B', 'CE'], 'truck')).toBe(true);
    expect(categoryAllows(['D1'], 'bus')).toBe(true);
    expect(categoryAllows(['A2'], 'car')).toBe(false);
    expect(categoryAllows(['A'], 'motorcycle')).toBe(true);
    expect(categoryAllows(['B1'], 'other')).toBe(true);
    expect(categoryAllows([], 'car')).toBe(false);
    expect(categoryAllows(['ZZ'], 'car')).toBe(false);
  });

  test('every vehicle type can be driven with some category', () => {
    for (const type of VEHICLE_TYPES) {
      expect(LICENSE_CATEGORIES.some((c) => categoryAllows([c], type)), type).toBe(true);
    }
    expect(Object.keys(LICENSE_CATEGORY_VEHICLE_TYPES)).toEqual(LICENSE_CATEGORIES);
  });

  test('categories are kept in licence order without duplicates', () => {
    expect(normalizeCategories(['DE', 'B', 'AM', 'B'])).toEqual(['AM', 'B', 'DE']);
  });
});
