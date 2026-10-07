import { createApp } from './app';
import { config } from './config';
import { logger } from './shared/logging/logger';

createApp().listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'fms-backend listening');
});
