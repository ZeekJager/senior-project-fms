import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  MAX_UNKNOWN_DEVICES_PER_PROVIDER,
  deviceNotFound,
  identifierTaken,
  providerNotTelematics,
  vehicleHasDevice,
  vehicleNotLinkable,
  type DeviceView,
  type UnknownDeviceView,
} from '../domain/device';
import type { PingInput } from '../domain/gps';
import type { DeviceListRow, DeviceRepository } from '../infrastructure/device.repository';
import type { IntegrationRepository } from '../infrastructure/integration.repository';
import type { IngestionService, IngestVehicle } from './ingestion.service';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

/** What the registry needs from fleet (connected in integration/index.ts). */
export interface DeviceRefs {
  vehicles: {
    byPublicIds(db: Queryable, publicIds: readonly string[], scope: Scope): Promise<IngestVehicle[]>;
    /** Internal ids of the vehicles in a scope; null means every vehicle. */
    idsInScope(db: Queryable, scope: Scope): Promise<string[] | null>;
    refsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; registrationNumber: string }>>;
  };
}

export interface DeviceServiceDeps {
  devices: DeviceRepository;
  providers: IntegrationRepository;
  ingestion: IngestionService;
  refs: DeviceRefs;
  now?: () => number;
}

export interface LinkInput {
  provider_id: string;
  device_identifier: string;
  vehicle_id: string;
  device_model?: string | null;
  /** Take the vehicle's other active device out of service instead of refusing (409 vehicle_has_device). */
  replace: boolean;
}

/** Unknown device ids listed at most. */
const UNKNOWN_LIMIT = 200;

/**
 * The device registry (FMS-138, docs/telematics.md): which provider device reports for which vehicle, and the
 * consumer that turns a telematics provider's positions into pings and counts what it refused. A device is
 * seen through its vehicle: a caller lists, links and unlinks devices of the vehicles in their depot scope.
 */
export class DeviceService {
  private readonly now: () => number;

  constructor(private readonly deps: DeviceServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** GET /integrations/devices: the devices of the caller's vehicles, active first, newest seen first. */
  async list(caller: Caller, filter: { provider?: string; status?: 'active' | 'removed' }): Promise<DeviceView[]> {
    const { devices, providers } = this.deps;
    const db = devices.pool();
    const scope = depotScope(caller.user);
    if (scope.kind === 'none') return [];
    let providerId: string | null = null;
    if (filter.provider) {
      const provider = await providers.findProvider(db, filter.provider);
      if (!provider) return [];
      providerId = provider.id;
    }
    const vehicleIds = await this.deps.refs.vehicles.idsInScope(db, scope);
    if (vehicleIds?.length === 0) return [];
    return this.views(db, await devices.list(db, vehicleIds, { providerId, status: filter.status }));
  }

  /** GET /integrations/devices/unknown: device ids providers sent that are linked to no vehicle, newest first. */
  async unknown(): Promise<UnknownDeviceView[]> {
    const { devices } = this.deps;
    const rows = await devices.listUnknown(devices.pool(), UNKNOWN_LIMIT);
    return rows.map((r) => ({
      provider: { id: r.providerPublicId, code: r.providerCode, name: r.providerName },
      device_identifier: r.identifier,
      first_seen_at: r.firstSeenAt,
      last_seen_at: r.lastSeenAt,
      positions: r.positions,
    }));
  }

  /**
   * POST /integrations/devices: links a provider's device to a vehicle of the caller's scope, so its webhook
   * positions become the vehicle's. The same device again moves it (from another vehicle, or back from removed).
   * The vehicle's other active device is refused (409) unless `replace` takes it out of service. Every change audited.
   */
  link(caller: Caller, input: LinkInput): Promise<DeviceView> {
    return this.linkIn({ userId: caller.user.id, correlationId: caller.correlationId }, depotScope(caller.user), input);
  }

  /** The same for a script (the GPS simulator): any vehicle, audited without a user. */
  linkAsSystem(input: LinkInput, ctx: MutationContext): Promise<DeviceView> {
    return this.linkIn(ctx, { kind: 'all' }, input);
  }

  private async linkIn(ctx: MutationContext, scope: Scope, input: LinkInput): Promise<DeviceView> {
    const { devices, providers, refs } = this.deps;
    const id = await devices.inTransaction(async (client) => {
      const provider = await providers.findProvider(client, input.provider_id);
      if (!provider) throw providerNotTelematics('references_missing_record');
      if (provider.providerType !== 'telematics') throw providerNotTelematics('not_telematics');
      const [vehicle] = await refs.vehicles.byPublicIds(client, [input.vehicle_id], scope);
      if (!vehicle) throw vehicleNotLinkable('references_missing_record');
      if (!vehicle.isActive) throw vehicleNotLinkable('vehicle_retired');

      const existing = await devices.findByIdentifier(client, input.device_identifier);
      if (existing && existing.providerId !== provider.id) throw identifierTaken();
      const occupant = await devices.activeForVehicle(client, vehicle.id);
      if (occupant && occupant.id !== existing?.id) {
        if (!input.replace) throw vehicleHasDevice(occupant.identifier, occupant.publicId);
        await devices.remove(ctx, occupant.id, client);
      }
      await devices.forgetUnknown(client, provider.id, input.device_identifier);
      if (existing) {
        if (existing.status === 'active' && existing.vehicleId === vehicle.id && input.device_model === undefined) return existing.id;
        await devices.relink(ctx, existing.id, vehicle.id, input.device_model, client);
        return existing.id;
      }
      const row = await devices.insert(
        ctx,
        { vehicle_id: vehicle.id, provider_id: provider.id, device_identifier: input.device_identifier, device_model: input.device_model ?? null, token_hash: null },
        client,
      );
      return row.id as string;
    });
    return this.one(devices.pool(), { id });
  }

  /**
   * DELETE /integrations/devices/{id}: unlinks a device of the caller's vehicles. It is kept as `removed` (its
   * history stays with its pings); a token device's token stops working. Unlinking it again changes nothing.
   */
  async unlink(caller: Caller, publicId: string): Promise<DeviceView> {
    const { devices, refs } = this.deps;
    const ctx: MutationContext = { userId: caller.user.id, correlationId: caller.correlationId };
    const id = await devices.inTransaction(async (client) => {
      const device = await devices.findListRow(client, { publicId });
      const scope = depotScope(caller.user);
      if (!device || scope.kind === 'none') throw deviceNotFound();
      const inScope = await refs.vehicles.idsInScope(client, scope);
      if (inScope && !inScope.includes(device.vehicleId)) throw deviceNotFound();
      if (device.status !== 'removed') await devices.remove(ctx, device.id, client);
      return device.id;
    });
    return this.one(devices.pool(), { id });
  }

  /**
   * A telematics provider's delivery of positions (IntegrationWebhookReceived), on the event's transaction: the
   * positions of its linked devices become pings; the rest are refused. Today's counts get both, and each unlinked
   * device id is noted for the registry, so an admin sees it and can link it.
   */
  async ingestDelivery(tx: PoolClient, provider: { id: string; code: string }, positions: readonly PingInput[], correlationId: string): Promise<void> {
    const { devices, providers, ingestion } = this.deps;
    const result = await ingestion.ingest({ kind: 'provider', providerId: provider.id, providerCode: provider.code }, positions, correlationId, tx);
    const at = new Date(this.now());
    await providers.addCounts(tx, provider.id, at, { positions_accepted: result.accepted + result.duplicates, positions_rejected: result.rejected.length });
    const unknown = new Map<string, number>();
    for (const { index, reason } of result.rejected) {
      const identifier = positions[index]?.device_id;
      if (reason === 'unknown_device' && identifier) unknown.set(identifier, (unknown.get(identifier) ?? 0) + 1);
    }
    await devices.noteUnknown(tx, provider.id, unknown, at, MAX_UNKNOWN_DEVICES_PER_PROVIDER);
  }

  private async one(db: Queryable, by: { id: string }): Promise<DeviceView> {
    const row = await this.deps.devices.findListRow(db, by);
    return (await this.views(db, [row!]))[0];
  }

  private async views(db: Queryable, rows: readonly DeviceListRow[]): Promise<DeviceView[]> {
    const vehicles = await this.deps.refs.vehicles.refsByIds(db, [...new Set(rows.map((r) => r.vehicleId))]);
    return rows.map((r) => {
      const vehicle = vehicles.get(r.vehicleId)!;
      return {
        id: r.publicId,
        device_identifier: r.identifier,
        device_model: r.model,
        provider: r.providerPublicId ? { id: r.providerPublicId, code: r.providerCode!, name: r.providerName! } : null,
        credential: r.providerId ? 'provider' : 'token',
        vehicle: { id: vehicle.publicId, registration_number: vehicle.registrationNumber },
        status: r.status,
        installed_at: r.installedAt,
        removed_at: r.removedAt,
        last_seen_at: r.lastSeenAt,
        last_error: r.lastErrorReason && r.lastErrorAt ? { reason: r.lastErrorReason, at: r.lastErrorAt } : null,
      };
    });
  }
}
