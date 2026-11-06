import { ThreadsError } from './types.js';

export interface DirectProfileCommand extends Record<string, unknown> {
  type: 'direct_profile';
  username: string;
  maxPages: number;
  pageSize: number;
}

/** The direct reader accepts a profile identity and bounds, never a URL or query payload. */
export function validateDirectProfileCommand(input: unknown): asserts input is DirectProfileCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ThreadsError('INVALID_COMMAND', 'Invalid direct profile command.');
  const command = input as Record<string, unknown>;
  const keys = Object.keys(command);
  if (keys.length !== 4 || keys.some(key => !['type', 'username', 'maxPages', 'pageSize'].includes(key)) ||
      command.type !== 'direct_profile' || typeof command.username !== 'string' || !/^[A-Za-z0-9_.]{1,30}$/.test(command.username) ||
      !Number.isInteger(command.maxPages) || Number(command.maxPages) < 1 || Number(command.maxPages) > 5 ||
      !Number.isInteger(command.pageSize) || Number(command.pageSize) < 1 || Number(command.pageSize) > 20)
    throw new ThreadsError('INVALID_COMMAND', 'Direct profile requires a username, maxPages 1–5 and pageSize 1–20 only.');
}
