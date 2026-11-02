# Photos of people and vehicles

Every user account (any role: driver, dispatcher, fleet manager, technician, admin) and every vehicle may have one photo. Without one, the screens show a **placeholder**: a person's initials on a colour of their own (the same colour every time, from their name), or the vehicle type's icon (truck, bus, van, car, SUV, motorcycle).

## Who sets which

| Photo | Set and removed by | Where on screen | API |
|---|---|---|---|
| Your own | Everyone, for themselves | Account card in the menu (click your picture): *Your photo* | `PUT` / `DELETE /auth/me/photo` |
| Any user's | Admin (`users:write`) | Users and Roles (S-20), the user's edit panel | `PUT` / `DELETE /users/{user_id}/photo` |
| A driver's | Whoever manages drivers (`driver:write`: admin, fleet manager, depot admin), in their depots | Drivers (S-05), the driver's edit panel | `PUT` / `DELETE /drivers/{driver_id}/photo` |
| A vehicle's | Whoever edits vehicles (`vehicle:write`), in their depots | Vehicles (S-04), the vehicle's edit panel | `PUT` / `DELETE /vehicles/{vehicle_id}/photo` |

A driver's photo is their account's: the same photo shows on the Drivers list, the Users list and their own account card.

**Who sees whom.** Your own photo, always. A colleague's: those who see people lists (`users:read` or `driver:read`). Anyone else gets `404`, as for no photo. A vehicle's: `vehicle:read` in its depot.

## How it works

1. **In the browser** (`packages/frontend/src/lib/photo.ts`): the picture (JPEG, PNG or WebP, up to 25 MB as picked) is turned upright from its EXIF, cropped to fill (a square for people, 4:3 for vehicles) and shrunk (512 px, or 1280 x 960; never enlarged), then sent as a JPEG of about 50–200 KB. The server never decodes images.
2. **On the server** (`packages/backend/src/shared/storage/photo.ts`): the `file` part, 2 MB at most (`413`), must be JPEG, PNG or WebP by its first bytes, whatever its name or declared type (`415`). It is stored in the **document storage** (local disk or S3, like documents) under `photos/<users|vehicles>/<id>/<time>`, never in PostgreSQL. The row records the key, the type and when it changed (migration 057: `photo_key`, `photo_type`, `photo_updated_at` on `auth.users` and `fleet.vehicles`). The previous file is removed. Audited: `photo.updated`, `photo.removed`.
3. **Shown** from `photo_url`, on `User`, `Driver`, `Vehicle` and `/auth/me`: `/api/v1/users/{id}/photo?v=<ms>` or `/api/v1/vehicles/{id}/photo?v=<ms>`. The `v` changes with the photo, so the image is cached privately for a day and a new photo shows at once. Served with its type, `nosniff` and `Content-Security-Policy: default-src 'none'`. A photo that fails to load falls back to the placeholder.

## Code

- Backend: `src/shared/storage/photo.ts` (type check, URL, key, upload middleware, sending); users in `src/modules/auth/application/user-photo.service.ts` and `api/user-photo.routes.ts` (exported as `userPhotos` for the fleet module); vehicles and drivers in `src/modules/fleet/application/photo.service.ts` and `api/photo.routes.ts`.
- Frontend: `src/components/shared/Avatar.tsx` (`Avatar`, `VehiclePhoto`: photo or placeholder), `src/components/shared/PhotoUploader.tsx` (click or drop, preview, change, remove), `src/lib/photo.ts` (crop and shrink).
- Tests: `packages/backend/test/integration/photos.test.ts`, `packages/frontend/src/components/shared/photos.test.tsx`.
