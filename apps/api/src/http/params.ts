import type { Request } from 'express';
import { AppError } from './errors';

/** Read a required string path parameter, narrowing away undefined/array types. */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION', `Missing path parameter: ${name}`);
  }
  return value;
}
