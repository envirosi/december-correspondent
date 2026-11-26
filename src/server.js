const { migrate } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');
const T = require('./time');

(async () => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_CLOCK_OVERRIDE === '1') {
    console.error('Refusing to start: clock override is not allowed in production.');
    process.exit(1);
  }
  await migrate();
  const { doors } = await seed();
  console.log('doors', doors);
  if (T.clockOverrideAllowed()) console.log('REHEARSAL MODE: clock override enabled');
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`December Correspondent on :${port}`));
})().catch(e => { console.error(e); process.exit(1); });
