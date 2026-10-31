import type { Logger } from 'pino';
import type { AdminIdentity } from '../services/authService';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      admin?: AdminIdentity;
      sessionToken?: string;
    }
  }
}

export {};
