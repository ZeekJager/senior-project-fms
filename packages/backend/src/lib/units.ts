/**
 * FMS-04: Money/Fuel type safety shared module.
 * Converts to and from integer formats for storage.
 * NEVER USE parseFloat OR division for money/fuel outside this file!
 */

type Amount = number | string;

export function toMillilitres(litres: Amount): number;
export function toMillilitres(litres: null | undefined): null | undefined;
export function toMillilitres(litres: Amount | null | undefined): number | null | undefined {
  if (litres === null || litres === undefined) return litres;
  return Math.round(Number(litres) * 1000);
}

export function toLitres(ml: Amount): string;
export function toLitres(ml: null | undefined): null | undefined;
export function toLitres(ml: Amount | null | undefined): string | null | undefined {
  if (ml === null || ml === undefined) return ml;
  return (Number(ml) / 1000).toFixed(2);
}

export function toCents(birr: Amount): number;
export function toCents(birr: null | undefined): null | undefined;
export function toCents(birr: Amount | null | undefined): number | null | undefined {
  if (birr === null || birr === undefined) return birr;
  return Math.round(Number(birr) * 100);
}

export function toBirr(cents: Amount): string;
export function toBirr(cents: null | undefined): null | undefined;
export function toBirr(cents: Amount | null | undefined): string | null | undefined {
  if (cents === null || cents === undefined) return cents;
  return (Number(cents) / 100).toFixed(2);
}
