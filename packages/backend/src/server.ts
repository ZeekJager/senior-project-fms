import { createApp } from './app';
import { config } from './config';

createApp().listen(config.port, () => {
  console.log(`[fms-backend] running on port ${config.port} (${config.nodeEnv})`);
});
