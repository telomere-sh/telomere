import { loadConfig } from '../src/config.js';
import { configuredNearProvider } from '../src/providers/configured.js';
import { getNearProviderReadiness } from '../src/providers/index.js';

try {
  const readiness = await getNearProviderReadiness(configuredNearProvider(loadConfig(process.env)));
  process.stdout.write(JSON.stringify({ readOnly: true, reportGets: 0, paidPosts: 0, readiness }) + '\n');
  if (readiness.state !== 'ready') process.exitCode = 1;
} catch {
  process.stderr.write(JSON.stringify({ status: 'configuration_unavailable', reportGets: 0, paidPosts: 0 }) + '\n');
  process.exitCode = 1;
}
