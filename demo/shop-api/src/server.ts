import { createApp } from './app';
import { config } from './config';
import { log } from './lib/logger';
import { seedDemoData } from './seed';

seedDemoData();
createApp().listen(config.port, () => {
  log('info', 'shop-api listening', { port: config.port });
  console.log(`shop-api on http://localhost:${config.port}`);
});
