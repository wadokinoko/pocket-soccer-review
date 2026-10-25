import { handleApi } from './api-worker.js';

// Isolated staging entry point. It intentionally does not include the production /ws relay.
export default {
  async fetch(request, env) {
    const response = await handleApi(request, env);
    if (response) return response;
    return new Response('Not Found', { status: 404 });
  },
};
