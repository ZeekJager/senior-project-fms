import pino, { type DestinationStream, type Logger } from 'pino';

/** Never written to logs: credentials, tokens and session cookies. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'password_hash',
  'token',
  'secret',
  '*.password',
  '*.password_hash',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.jwtSecret',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'fms-backend' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}
