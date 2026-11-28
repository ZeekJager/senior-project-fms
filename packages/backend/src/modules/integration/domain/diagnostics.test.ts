import { describe, expect, it } from 'vitest';
import { codeOf, describe as describeCode, diagnosticEntry, severityOf } from './diagnostics';

// FMS-132: the webhook's codes, what they are kept under, and how severe their alert is.

const at = '2026-11-27T08:00:00Z';
const obd = (code: string) => diagnosticEntry.parse({ device_id: 'd', protocol: 'obd2', code, status: 'active', observed_at: at });
const j1939 = (spn: number, fmi: number) => diagnosticEntry.parse({ device_id: 'd', protocol: 'j1939', spn, fmi, status: 'active', observed_at: at });

describe('diagnostic trouble codes', () => {
  it('reads OBD-II codes and J1939 SPN and FMI, and nothing else', () => {
    expect(codeOf(obd('P0217'))).toBe('P0217');
    expect(codeOf(j1939(110, 0))).toBe('110-0');
    for (const bad of ['p0217', 'P4217', 'X0100', 'P021']) expect(diagnosticEntry.safeParse({ device_id: 'd', protocol: 'obd2', code: bad, status: 'active', observed_at: at }).success).toBe(false);
    expect(diagnosticEntry.safeParse({ device_id: 'd', protocol: 'j1939', spn: 110, fmi: 32, status: 'active', observed_at: at }).success).toBe(false);
    expect(diagnosticEntry.safeParse({ device_id: 'd', protocol: 'j1939', code: 'P0217', spn: 110, fmi: 0, status: 'active', observed_at: at }).success).toBe(false);
  });

  it('severity: the dictionary when it names the code, else its class; J1939 most-severe modes one level up', () => {
    expect(severityOf(obd('P0217'), 'critical')).toBe('critical');
    expect(severityOf(obd('P1234'), null)).toBe('medium');
    expect(severityOf(obd('B1234'), null)).toBe('low');
    expect(severityOf(j1939(9999, 2), null)).toBe('medium');
    expect(severityOf(j1939(9999, 1), null)).toBe('high');
    expect(severityOf(j1939(110, 0), 'critical')).toBe('critical');
  });

  it('a J1939 description names its failure mode', () => {
    expect(describeCode(j1939(110, 0), 'Engine coolant temperature')).toBe('Engine coolant temperature: above normal, most severe');
    expect(describeCode(obd('P0217'), 'Engine overheating')).toBe('Engine overheating');
    expect(describeCode(obd('P1234'), null)).toBeNull();
  });
});
