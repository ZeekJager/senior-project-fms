/**
 * FMS-04: Money/Fuel type safety shared module (Frontend ESM).
 * Converts to and from integer formats for storage.
 * NEVER USE parseFloat OR division for money/fuel outside this file!
 */

export function toMillilitres(litres) {
    if (litres === null || litres === undefined) return litres;
    return Math.round(Number(litres) * 1000);
}

export function toLitres(ml) {
    if (ml === null || ml === undefined) return ml;
    return (Number(ml) / 1000).toFixed(2);
}

export function toCents(birr) {
    if (birr === null || birr === undefined) return birr;
    return Math.round(Number(birr) * 100);
}

export function toBirr(cents) {
    if (cents === null || cents === undefined) return cents;
    return (Number(cents) / 100).toFixed(2);
}
