import type { Session } from './session.ts';
import type { Submitter } from './server.ts';

export function makeSubmitter(_session: Session): Submitter {
  return async () => {
    throw new Error('rv submit is not implemented yet');
  };
}
