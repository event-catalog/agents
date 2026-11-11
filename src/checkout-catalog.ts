import { parseArgs } from 'node:util';
import { isAzurePipelines, resolveConfig, type ReviewPayload } from '@/src/config';
import { checkoutCatalog } from '@/src/utils/checkout-catalog';

/**
 * Checks out the catalog repository into `eventcatalog/`, from GitHub, Azure DevOps or Bitbucket:
 *
 *   tsx src/checkout-catalog.ts [--payload '<json>']
 *
 * Reads the same payload and `EVENTCATALOG_*` environment as `src/run.ts`.
 */
const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { payload: { type: 'string' } } });
  const payload = values.payload ? (JSON.parse(values.payload) as ReviewPayload) : undefined;
  await checkoutCatalog(resolveConfig(payload, process.env));
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (isAzurePipelines(process.env)) console.log(`##vso[task.logissue type=error]${message.replace(/\r?\n/g, ' ')}`);
  console.error(`[eventcatalog:checkout] ${message}`);
  process.exitCode = 1;
});
