import { config } from '../../config';
import { createLogger } from './create-logger';

/** Structured JSON logger. Use this (or `req.log`) instead of `console`. */
export const logger = createLogger(config.logLevel);
