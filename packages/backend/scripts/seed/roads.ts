import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LineString } from '../../src/modules/trip/domain/road';
import type { Place } from './catalog';
import { decodePolyline } from './polyline';

// The roads between the seed's depots and cities (FMS-84), measured once with OSRM on the OpenStreetMap
// Ethiopia extract and committed (roads.json, rebuilt by `npm run routes:roads`), so the seed and CI need no
// routing engine and every run draws the same roads.

/** One measured road: its length and OSRM's driving time, and the line (encoded polyline, [lng, lat]). */
export interface SeedRoad {
  distance_km: number;
  duration_s: number;
  polyline: string;
}

export interface SeedRoadFile {
  source: string;
  attribution: string;
  tolerance_m: number;
  /** By `roadKey(from, to)`. */
  roads: Record<string, SeedRoad>;
}

export const ROADS_FILE = join(__dirname, 'roads.json');

export const roadKey = (from: string, to: string) => `${from} → ${to}`;

let loaded: SeedRoadFile | null = null;

function file(): SeedRoadFile {
  loaded ??= JSON.parse(readFileSync(ROADS_FILE, 'utf8')) as SeedRoadFile;
  return loaded;
}

/** The measured road from one place to another, or undefined when roads.json has none for the pair. */
export function seedRoad(from: Place, to: Place): SeedRoad | undefined {
  return file().roads[roadKey(from.city, to.city)];
}

/**
 * The road's line from `from` to `to`, starting and ending on the places themselves (the road starts where
 * OSRM joined it, up to a few hundred metres away). Throws when roads.json has no road for the pair.
 */
export function roadLine(from: Place, to: Place): LineString {
  const road = seedRoad(from, to);
  if (!road) throw new Error(`No road from ${from.city} to ${to.city} in roads.json: run npm run routes:roads`);
  const line = decodePolyline(road.polyline);
  const ends: [number, number][] = [
    [from.longitude, from.latitude],
    [to.longitude, to.latitude],
  ];
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  const coordinates = [...(same(line[0], ends[0]) ? [] : [ends[0]]), ...line, ...(same(line.at(-1)!, ends[1]) ? [] : [ends[1]])];
  return { type: 'LineString', coordinates };
}
