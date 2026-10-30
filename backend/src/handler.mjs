import { createHandler } from './service.mjs';
import { store } from './store.mjs';
export const handler = createHandler(store);
export async function cleanup(event, context) { await store.cleanup(context); }
