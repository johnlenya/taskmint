import { createDatabaseClient, createSiteContext, errorResponse, BackendError } from './_qoder/backend.mjs';
import { application } from './routes.mjs';

const env = (name: string) => Deno.env.get(name) || '';

const handle = application({
  db: createDatabaseClient(),
  BackendError,
  secrets: { portal: env('PORTAL_SECRET'), offerwall: env('OFFERWALL_SECRET'), admin: env('ADMIN_KEY') },
  // Sandbox deployment: offers settle from simulated partner confirmation.
  // Flip to false together with wording and offer partners before real payouts.
  sandbox: true,
});

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
