/**
 * Proxy module exports
 * Issue #42: Proxy routing for multiple frontend applications
 */

export { logProxyRequest, logProxyError } from './logger';
export type { ProxyLogEntry } from './logger';

export {
  proxyHttp,
  proxyWebSocket,
  isWebSocketUpgrade,
  buildUpstreamUrl,
} from './handler';
