import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { featureSpecLoader } from '../infrastructure/feature-spec';
import { canonicalJson, featureSpecHash } from './ml-model';

// The core and the ML service hash the same feature spec the same way (FMS-127): Node's canonical JSON is
// byte for byte Python's json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).

describe('canonicalJson writes what Python writes', () => {
  test('sorted keys by code point, no spaces, everything outside printable ASCII escaped', () => {
    const value = {
      b: [1, 2.5, -0.25, null, true, false],
      a: { z: 'Addis Ababa – é ☃ 😀', y: 'tab\there\nquote" back\\ del\x7f ctl\x01' },
      B: 0,
      é: 1,
      aa: 123456789012345,
    };
    // Printed by Python 3 for the same value.
    const python = String.raw`{"B":0,"a":{"y":"tab\there\nquote\" back\\ del\u007f ctl\u0001","z":"Addis Ababa \u2013 \u00e9 \u2603 \ud83d\ude00"},"aa":123456789012345,"b":[1,2.5,-0.25,null,true,false],"\u00e9":1}`;
    expect(canonicalJson(value)).toBe(python);
  });

  test('numbers Python writes differently are refused, not hashed differently', () => {
    for (const n of [1e-5, 0.00005, 1e21, 1e16, Number.NaN, Infinity]) expect(() => canonicalJson({ n })).toThrow(/canonical/);
    expect(canonicalJson([0.0001, 999_999_999_999_999, -3])).toBe('[0.0001,999999999999999,-3]');
  });
});

describe('the feature spec hash', () => {
  test('covers the inputs and the label only', () => {
    const spec = { features: [{ name: 'mileage_km', min: 0 }], target: { name: 'failed' } };
    const expected = createHash('sha256').update('{"features":[{"min":0,"name":"mileage_km"}],"target":{"name":"failed"}}').digest('hex');
    expect(featureSpecHash(spec)).toBe(expected);
    expect(featureSpecHash({ ...spec, description: 'changed', spec_version: 9 } as typeof spec)).toBe(expected);
    expect(featureSpecHash({ ...spec, features: [{ name: 'mileage_km', min: 1 }] })).not.toBe(expected);
  });

  test("is the ML service's spec_hash() of feature_spec.json", () => {
    // `python -c "from ml.spec import spec_hash; print(spec_hash())"` in packages/ai-service. A change to the
    // spec changes it on both sides: retrain the model, then update this value.
    const spec = featureSpecLoader('../ai-service/feature_spec.json')();
    expect(spec.hash).toBe('b81af7ff0446aaf63946fcb12fae3a4b0cccaeecbc1a94d04d2b035a048e2f10');
    expect(spec.features).toHaveLength(19);
    expect(spec.features[0]).toBe('mileage_km');
  });
});
