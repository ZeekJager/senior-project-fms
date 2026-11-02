import { AppError } from '../../../shared/errors/app-error';

// Stop-order optimisation (FMS-86, docs/eta.md): the order of a route's stops that makes the road from origin to
// destination shortest, by nearest neighbour then 2-opt over the routing engine's distance table. Pure, so it is
// unit-tested on fixtures.
//
// The table is indexed by waypoint: 0 the origin, 1..n the stops in their saved order, n + 1 the destination.
// Road distances are not symmetric (one-way streets), so every candidate order is costed whole, never by the
// usual symmetric 2-opt shortcut. With at most 25 stops that is a few thousand sums per pass.

/** An order of the stops: 0-based indexes into the saved stops. */
export type StopOrder = number[];

/** Length of origin -> stops in `order` -> destination over `table` (metres, or whatever the table holds). */
export function orderLength(table: readonly (readonly number[])[], order: readonly number[]): number {
  const destination = table.length - 1;
  const path = [0, ...order.map((i) => i + 1), destination];
  let total = 0;
  for (let i = 1; i < path.length; i++) total += table[path[i - 1]][path[i]];
  return total;
}

/** From the origin, always to the nearest stop not yet visited. */
export function nearestNeighbour(table: readonly (readonly number[])[]): StopOrder {
  const stops = table.length - 2;
  const left = new Set(Array.from({ length: stops }, (_, i) => i));
  const order: StopOrder = [];
  let at = 0;
  while (left.size > 0) {
    let best = -1;
    for (const i of left) if (best === -1 || table[at][i + 1] < table[at][best + 1]) best = i;
    order.push(best);
    left.delete(best);
    at = best + 1;
  }
  return order;
}

/** 2-opt with fixed ends: reverses any stretch of the order that makes it shorter, until none does. */
export function twoOpt(table: readonly (readonly number[])[], start: StopOrder): StopOrder {
  let order = [...start];
  let length = orderLength(table, order);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const candidateLength = orderLength(table, candidate);
        // A strict gain beyond rounding, so equal-length reversals cannot cycle.
        if (candidateLength < length - 1e-9) {
          order = candidate;
          length = candidateLength;
          improved = true;
        }
      }
    }
  }
  return order;
}

export interface Optimised {
  order: StopOrder;
  /** Over the same table: the saved order's length and the one returned. */
  originalLength: number;
  optimisedLength: number;
  /** False when the saved order is already as short as anything found: `order` is then the saved one. */
  changed: boolean;
}

/**
 * The shortest order found, never longer than the saved one (acceptance): nearest neighbour and 2-opt from it,
 * and 2-opt from the saved order too; the saved order is kept unless one of them is strictly shorter.
 */
export function optimiseOrder(table: readonly (readonly number[])[]): Optimised {
  const stops = table.length - 2;
  const saved = Array.from({ length: stops }, (_, i) => i);
  const originalLength = orderLength(table, saved);
  if (stops < 2) return { order: saved, originalLength, optimisedLength: originalLength, changed: false };
  let best = saved;
  let bestLength = originalLength;
  for (const candidate of [twoOpt(table, nearestNeighbour(table)), twoOpt(table, saved)]) {
    const length = orderLength(table, candidate);
    if (length < bestLength - 1e-9) {
      best = candidate;
      bestLength = length;
    }
  }
  return { order: best, originalLength, optimisedLength: bestLength, changed: best !== saved };
}

export const routeNotOptimisable = (reason: 'route_without_ends' | 'stop_without_coordinates' | 'no_road', field: 'origin' | 'destination' | 'stops' = 'stops') =>
  new AppError(
    400,
    'VALIDATION_FAILED',
    reason === 'route_without_ends'
      ? 'The route needs origin and destination coordinates before its stops can be ordered.'
      : reason === 'stop_without_coordinates'
        ? 'Every stop needs coordinates before the stops can be ordered.'
        : 'The routing engine found no road between some of the stops.',
    [{ field, reason }],
  );

export const routingUnavailable = () =>
  new AppError(503, 'UPSTREAM_UNAVAILABLE', 'The routing engine is not available. Try again in a minute.', [{ field: 'routing', reason: 'routing_unavailable' }], { 'Retry-After': '60' });
