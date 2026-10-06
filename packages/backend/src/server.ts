import { createApp } from './app';

const PORT = Number(process.env.PORT ?? 3000);

createApp().listen(PORT, () => {
  console.log(`[fms-backend] running on port ${PORT}`);
});
