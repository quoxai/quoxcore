/**
 * Consent commands: list, grant, history
 */

import { formatOutput, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerConsentCommands(program, ctx) {
  const { client, auth } = ctx;

  const consent = program
    .command('consent')
    .description('Manage data processing consent');

  consent
    .command('list')
    .description('List consent records')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('consent.list').path, { service: resolveEndpoint('consent.list').service });
      // fleet #435: GET /api/consent returns a single record
      // ({ai_data_sharing_consent, provider_consent, consent_version, updated_at}),
      // not a {consents:[...]} list, so the old row shape always rendered empty.
      const providerConsent = data.provider_consent || {};
      const rows = Object.keys(providerConsent).length
        ? Object.entries(providerConsent).map(([provider, granted]) => ({
            provider,
            granted: granted ? 'yes' : 'no',
            updated_at: data.updated_at || '',
          }))
        : [{
            provider: '(data sharing)',
            granted: data.ai_data_sharing_consent ? 'yes' : 'no',
            updated_at: data.updated_at || '',
          }];
      formatOutput({
        columns: ['provider', 'granted', 'updated_at'],
        headers: ['Provider', 'Granted', 'Updated'],
        rows,
      }, { format: program.opts().output });
    });

  consent
    .command('grant')
    .description('Grant consent for a provider')
    .requiredOption('--provider <provider>', 'provider name')
    .action(async (options) => {
      auth.requireAuth();
      // fleet #435: POST /api/consent takes
      // {ai_data_sharing_consent: boolean, provider_consent: {...}} and REPLACES
      // provider_consent wholesale, so read the current record and merge rather
      // than wiping consent for every other provider.
      const listEp = resolveEndpoint('consent.list');
      let current = {};
      try {
        const existing = await client.get(listEp.path, { service: listEp.service });
        current = existing?.provider_consent || {};
      } catch {
        current = {};
      }
      const createEp = resolveEndpoint('consent.create');
      await client.post(createEp.path, {
        service: createEp.service,
        body: {
          ai_data_sharing_consent: true,
          provider_consent: { ...current, [options.provider]: true },
        },
      });
      printSuccess(`Consent granted for ${options.provider}.`);
    });

  consent
    .command('history')
    .description('View consent change history')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('consent.history.list').path, { service: resolveEndpoint('consent.history.list').service });
      formatOutput({
        columns: ['provider', 'action', 'timestamp'],
        headers: ['Provider', 'Action', 'Time'],
        rows: data.history || data,
      }, { format: program.opts().output });
    });
}
