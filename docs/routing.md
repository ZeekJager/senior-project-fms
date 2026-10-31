# Road routing (FMS-84)

Routes follow the road. When a route is saved with an origin and a destination, the API asks the routing engine for the road through its waypoints: origin, the stops that have coordinates, destination. It keeps the road's line, and, unless a distance was typed, its length and driving time. The maps draw the line, the GPS simulator drives along it, and the seed's trips follow real roads.

The engine is [OSRM](https://project-osrm.org) v5.27.1, self-hosted in Docker on the OpenStreetMap extract of Ethiopia (decision D-05). It needs no API key, has no quota and works offline.

## Setting it up

```sh
make routing        # once: downloads the map (about 130 MB, checked against Geofabrik's MD5),
                    # builds the car road graph (about 2 minutes) and starts OSRM
```

- **Optional.** The `osrm` service is in the `routing` profile. `make dev` starts it only with `COMPOSE_PROFILES=routing` in `.env`. `make routing` starts it either way.
- **Shared map.** The prepared map lives in the `fms_osrm_data` volume (1-2 GB), shared by every checkout. `make routing` creates it as an external volume, so `make clean` (`down -v`) keeps it. To refresh the map, run `docker volume rm fms_osrm_data`, then `make routing`.
- **Connecting.** The backend in Docker reaches OSRM at `http://osrm:5000`, which `docker-compose.yml` sets as `ROUTING_URL`. Set `ROUTING_URL=` (empty) in `.env` to switch routing off.
- **Outside Docker.** An API run outside Docker uses `ROUTING_URL=http://127.0.0.1:5050`. The host port is `OSRM_HOST_PORT`, bound to 127.0.0.1 only.

## Behaviour

| On save | Distance and time | Road (`geometry`, `measured_at`) |
|---|---|---|
| Both ends, no distance typed | The road's, `distance_source: road` | Measured |
| Both ends, a distance typed | As typed, `distance_source: manual` | Measured |
| Origin, destination or stops changed | Measured again, unless typed | Measured again |
| Typed distance cleared (`null`) | The road's | Measured again |
| Other fields only (name, depot, retire) | Unchanged | Unchanged; the engine is not asked |
| Engine down, unset, or no road between the points | As typed (or left as it was) | None (`null`); the old road is removed if the ends moved |

- **A typed distance always wins.** The engine never overwrites it. Clearing it brings back the road's.
- **The engine down never blocks a save.** The route is saved with the distance typed in (the card's acceptance criterion). The `route-roads` job measures it later (below).
- **How a request reaches OSRM.** Through the integration gateway's internal client (`code: osrm`, FMS-85): 5 s per attempt, one retry, and OSRM's circuit breaker. The planner is `src/modules/trip/infrastructure/osrm.planner.ts`.
- **Caching.** Roads are cached in Redis for 7 days by waypoints (`<prefix>:cache:trip:road:<hash>`). Saving the same points again does not ask the engine.
- **Simplifying.** The line is simplified to within 15 m of OSRM's full line and rounded to 5 decimals. Addis Ababa to Mekelle keeps 3,004 of 14,303 points (about 58 KB), and its length stays within 0.3% of the road's.
- **Points off the map.** The extract covers Ethiopia only. A point outside it is joined to the nearest Ethiopian road, so a route to Djibouti measures only as far as that road.
- **Waypoint limit.** At most 30 waypoints: origin, 25 stops and destination fit (`--max-viaroute-size 30`).

## API

- `Route` gains `distance_source` (`road`, `manual` or `null`) and `measured_at` (when the road was measured, or `null`).
- `GET /routes/{route_id}/geometry` (`route:read`, depot scope) returns the road as a GeoJSON LineString (`[longitude, latitude]` pairs), or `data: null` while it is not measured. It is kept out of `Route` because lists should not carry tens of kilobytes per route.
- `RouteUpdated.changed_fields` names `geometry` when the road was measured again.

## The route-roads job

`route-roads` runs every hour. It measures up to 50 active routes that have both ends and no road yet: routes saved while the engine was down or before it was set up. A typed distance stays; the road is added. It stops at the first engine failure, and the next run tries again. Its run history counts `measured`, `no_road` and `failed`.

## The seed's roads

The seed must run without OSRM (CI has none), so the roads between its depots and cities are measured once and committed to `packages/backend/scripts/seed/roads.json`:

- **Contents.** 152 roads, from every depot's city to every other city, simplified to 40 m and stored as encoded polylines (about 600 KB).
- **Rebuilding.** Rebuild the file with `npm run routes:roads -w fms-backend` (OSRM on 127.0.0.1:5050) after changing the depots or cities in `scripts/seed/catalog.ts`, or to pick up a newer map.
- **What the seed uses it for.** A route's distance is its road's length, and its time is that distance at 55 km/h. Completed trips' GPS tracks follow the road. Routes are saved with `geometry`, `distance_source: road` and `measured_at` set to the anchor day, so every run writes the same.

## Map data and tiles

- **Attribution.** Roads come from OpenStreetMap: © OpenStreetMap contributors, ODbL 1.0. The maps already credit OpenStreetMap, and `roads.json` records the source and attribution.
- **Tile provider review.** The maps load tiles from `tile.openstreetmap.org`, unless `VITE_MAP_TILE_URL` names another tile server. That is fine for development and demos. OpenStreetMap's tile usage policy does not allow heavy production use, so production should set `VITE_MAP_TILE_URL` to a tile provider or to our own tile server (FMS-107).
