/**
 * Measures the roads between the seed's depots and cities with OSRM (FMS-84, docs/routing.md) and writes
 * scripts/seed/roads.json, which the seed reads, so neither the seed nor CI needs a routing engine.
 * Rerun after changing the depots or cities in scripts/seed/catalog.ts, or for a newer map.
 *
 *   make routing                       # OSRM on the host at 127.0.0.1:5050
 *   npm run routes:roads               # or: -- --osrm http://127.0.0.1:5050
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { simplifyLine } from '../src/modules/trip/domain/road';
import { CITIES, DEPOT_SITES, type Place } from './seed/catalog';
import { encodePolyline } from './seed/polyline';
import { ROADS_FILE, roadKey, type SeedRoad, type SeedRoadFile } from './seed/roads';

/** Coarser than the API's 15 m: the seed's tracks have a point every 4.6 km, and the file stays small. */
const TOLERANCE_M = 40;

async function measure(osrm: string, from: Place, to: Place): Promise<SeedRoad> {
  const url = `${osrm}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  const body = (await res.json()) as { code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] };
  const route = body.routes?.[0];
  if (!res.ok || body.code !== 'Ok' || !route) throw new Error(`No road from ${from.city} to ${to.city}: ${body.code}`);
  const line = simplifyLine({ type: 'LineString', coordinates: route.geometry.coordinates }, TOLERANCE_M);
  return { distance_km: Math.round(route.distance / 100) / 10, duration_s: Math.round(route.duration), polyline: encodePolyline(line.coordinates) };
}

async function main() {
  const { values } = parseArgs({ options: { osrm: { type: 'string', default: 'http://127.0.0.1:5050' } } });
  const osrm = String(values.osrm).replace(/\/+$/, '');
  const roads: Record<string, SeedRoad> = {};
  // Every route the seed can plan: from a depot's city to any other city.
  for (const depot of DEPOT_SITES) {
    for (const city of CITIES.filter((c) => c.city !== depot.city)) {
      roads[roadKey(depot.city, city.city)] = await measure(osrm, depot, city);
    }
  }
  const out: SeedRoadFile = {
    source: `OSRM v5.27.1 (car profile) on the OpenStreetMap Ethiopia extract from Geofabrik, measured ${new Date().toISOString().slice(0, 10)}`,
    attribution: '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
    tolerance_m: TOLERANCE_M,
    roads,
  };
  writeFileSync(ROADS_FILE, `${JSON.stringify(out, null, 1)}\n`);
  const sizes = Object.values(roads).map((r) => r.polyline.length);
  console.log(`${Object.keys(roads).length} roads, ${sizes.reduce((a, b) => a + b, 0)} characters of polyline, written to ${ROADS_FILE}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
