// CI must never report success after silently skipping the PostgreSQL suites.
// All integration suites run against an explicitly selected disposable database.
let valid = false;
try {
  const url = new URL(process.env.DATABASE_TEST_URL);
  valid = ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname) && url.pathname.length > 1;
} catch { /* Emit only the configuration field name, never connection credentials. */ }
if (!valid) throw new Error('DATABASE_TEST_URL is required for test:ci; use a disposable PostgreSQL database');
