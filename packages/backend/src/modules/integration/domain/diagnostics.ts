import { z } from 'zod';

// Diagnostic trouble codes from telematics (FMS-132, docs/diagnostic-codes.md): the engine fault codes a provider
// reports, OBD-II (SAE J2012: P0217) or J1939 (SPN and FMI), each active or cleared.

export const DIAGNOSTIC_PROTOCOLS = ['obd2', 'j1939'] as const;
export type DiagnosticProtocol = (typeof DIAGNOSTIC_PROTOCOLS)[number];
export type DiagnosticSeverity = 'low' | 'medium' | 'high' | 'critical';

/** At most this many codes in one delivery: more is refused whole (400), as an oversized batch of positions is. */
export const MAX_DIAGNOSTICS_PER_BATCH = 500;

/** An OBD-II code: its system (powertrain, chassis, body, network), then four characters. */
const OBD2_CODE = /^[PCBU][0-3][0-9A-F]{3}$/;

const common = {
  device_id: z.string().min(1).max(255),
  status: z.enum(['active', 'cleared']),
  observed_at: z.iso.datetime({ offset: true }),
};

/** One code as the FMS telematics webhook format carries it (docs/integrations.md). */
export const diagnosticEntry = z.discriminatedUnion('protocol', [
  z.strictObject({ ...common, protocol: z.literal('obd2'), code: z.string().regex(OBD2_CODE) }),
  z.strictObject({ ...common, protocol: z.literal('j1939'), spn: z.number().int().min(0).max(524_287), fmi: z.number().int().min(0).max(31) }),
]);
export type DiagnosticEntry = z.infer<typeof diagnosticEntry>;

export const diagnosticEntries = z.array(diagnosticEntry).min(1).max(MAX_DIAGNOSTICS_PER_BATCH);

/** The code a row is kept under: the OBD-II code, or SPN-FMI for J1939 (110-0). */
export function codeOf(entry: DiagnosticEntry): string {
  return entry.protocol === 'obd2' ? entry.code : `${entry.spn}-${entry.fmi}`;
}

/** The dictionary's key for an entry: the OBD-II code, or the J1939 SPN. */
export function dictionaryKeyOf(entry: DiagnosticEntry): string {
  return entry.protocol === 'obd2' ? entry.code : String(entry.spn);
}

/** J1939-73 failure mode identifiers: what is wrong with the parameter. */
const FMI_TEXT: Readonly<Record<number, string>> = {
  0: 'above normal, most severe',
  1: 'below normal, most severe',
  2: 'erratic or incorrect data',
  3: 'voltage above normal or shorted high',
  4: 'voltage below normal or shorted low',
  5: 'current below normal or open circuit',
  6: 'current above normal or grounded circuit',
  7: 'mechanical system not responding',
  8: 'abnormal frequency or pulse width',
  9: 'abnormal update rate',
  10: 'abnormal rate of change',
  11: 'root cause not known',
  12: 'bad intelligent device',
  13: 'out of calibration',
  14: 'special instructions',
  15: 'above normal, least severe',
  16: 'above normal, moderately severe',
  17: 'below normal, least severe',
  18: 'below normal, moderately severe',
  19: 'received network data in error',
  31: 'condition exists',
};

/**
 * What the code means: the dictionary's description, and for J1939 the failure mode after it
 * ("Engine coolant temperature: above normal, most severe"). Null when the dictionary does not name it.
 */
export function describe(entry: DiagnosticEntry, dictionary: string | null): string | null {
  if (!dictionary) return null;
  if (entry.protocol === 'obd2') return dictionary;
  const mode = FMI_TEXT[entry.fmi];
  return mode ? `${dictionary}: ${mode}` : dictionary;
}

const ORDER: readonly DiagnosticSeverity[] = ['low', 'medium', 'high', 'critical'];
const raise = (s: DiagnosticSeverity): DiagnosticSeverity => ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(s) + 1)];

/**
 * How severe the alert is (by code class): the dictionary's severity when it names the code; otherwise by its system,
 * body codes low and the rest medium. J1939's "most severe" failure modes (FMI 0 and 1) raise it one level.
 */
export function severityOf(entry: DiagnosticEntry, dictionary: DiagnosticSeverity | null): DiagnosticSeverity {
  const base = dictionary ?? (entry.protocol === 'obd2' && entry.code.startsWith('B') ? 'low' : 'medium');
  return entry.protocol === 'j1939' && (entry.fmi === 0 || entry.fmi === 1) ? raise(base) : base;
}

export const DIAGNOSTIC_EVENTS = {
  /** A code a vehicle had no active row for (FMS-132): the alert engine opens a vehicle fault alert for it. */
  faultDetected: 'VehicleFaultDetected',
  /** The provider cleared it: the alert closes by itself (ALERT_RESOLVERS). */
  faultCleared: 'VehicleFaultCleared',
} as const;

/** What happened to each code of a delivery. */
export type DiagnosticOutcome = 'raised' | 'repeated' | 'cleared' | 'ignored' | 'unknown_device';

/** GET /vehicles/{vehicle_id}/diagnostic-codes. */
export interface DiagnosticCodeView {
  id: string;
  vehicle_id: string;
  protocol: DiagnosticProtocol;
  code: string;
  spn: number | null;
  fmi: number | null;
  description: string | null;
  severity: DiagnosticSeverity;
  status: 'active' | 'cleared';
  first_seen_at: string;
  last_seen_at: string;
  occurrences: number;
  cleared_at: string | null;
  provider: string | null;
}
