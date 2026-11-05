/**
 * Node's `http`, for modules the main process loads at startup.
 *
 * An ESM `import ... from 'http'` reads every export to build its module, and the lazy
 * `WebSocket` and `EventSource` ones load undici, Node's fetch, which adds about 20ms to startup.
 * `getBuiltinModule` hands over the module without reading them. Types still come from `import
 * type`.
 */
export const http = process.getBuiltinModule('node:http');
