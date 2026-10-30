import "server-only";

/**
 * Server-side re-export of the shared entity decoder.
 *
 * The implementation moved to ../html-entities so the client-side posting
 * formatter can use the identical table. This file keeps the `server-only`
 * marker and the original import path, so the crawler and its tests are
 * unchanged.
 */
export { decodeEntities } from "../html-entities";
