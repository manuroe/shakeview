/**
 * The demo logs served with the app (`public/demo/`), shared by the landing page
 * that opens them and /decryption, which adds the other side of a demo conversation.
 *
 * @example
 * const bytes = await fetchDemoLog(DEMO_PEER['demo.log']); // the Element Web demo
 */
import { fetchBytes } from './fileValidator';

/**
 * The other side of each demo conversation: Bob on Element X (`demo.log`) and Alice
 * on Element Web (`demo-web.log`) share megolm sessions, so either one is the
 * sender rageshake the other's /decryption asks for.
 */
export const DEMO_PEER: Readonly<Record<string, string>> = {
  ['demo.log']: 'demo-web.log',
  ['demo-web.log']: 'demo.log',
};

/**
 * Fetch a demo log's bytes from the app's own assets; throws on an HTTP error so callers show it.
 *
 * @example const bytes = await fetchDemoLog('demo.log');
 */
export function fetchDemoLog(fileName: string): Promise<Uint8Array> {
  return fetchBytes(`${import.meta.env.BASE_URL}demo/${fileName}`);
}
