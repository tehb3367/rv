import { flagStr, type Parsed } from './args.ts';
import { discover } from './client.ts';

export const COMMON = ['json', 'session'];

export function session(p: Parsed) {
  return discover(flagStr(p, 'session'));
}
