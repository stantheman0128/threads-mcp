export interface RemoteCapabilities {
  extendedReads: boolean; delete: boolean; schedule: boolean;
  browserFallback: boolean; messages: boolean; officialApi: boolean;
}
export function remoteCapabilities(input: Partial<RemoteCapabilities> = {}): RemoteCapabilities {
  return { extendedReads: input.extendedReads === true, delete: input.delete === true, schedule: input.schedule === true,
    browserFallback: input.browserFallback === true, messages: input.messages === true, officialApi: input.officialApi === true };
}
export function remoteCapabilitiesFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteCapabilities {
  return remoteCapabilities({ extendedReads: env.THREADS_REMOTE_ALLOW_EXTENDED_READS === 'true', delete: env.THREADS_REMOTE_ALLOW_DELETE === 'true',
    schedule: env.THREADS_REMOTE_ALLOW_SCHEDULE === 'true', browserFallback: env.THREADS_REMOTE_ALLOW_BROWSER_FALLBACK === 'true',
    messages: env.THREADS_REMOTE_ALLOW_MESSAGES === 'true', officialApi: env.THREADS_REMOTE_ALLOW_OFFICIAL_API === 'true' });
}
