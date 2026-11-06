import type {ThreadsService} from './service.js';

/** Project connection health only. No page reads, token, tab title/URL or local paths. */
export async function remoteHealth(service:ThreadsService,refresh=true){
  let status:any;
  try{status=refresh&&service.driver.refreshStatus?await service.driver.refreshStatus():service.driver.status();}
  catch{status={connected:false,health:{state:'host-unreachable',checkedAt:new Date().toISOString(),errorCode:'HEALTH_FAILED'}};}
  const allowed=['unchecked','connected','extension-disconnected','host-unreachable','pairing-missing','auth-failed','pairing-invalid','closed'];
  const state=allowed.includes(status?.health?.state)?status.health.state:'unchecked';
  const checkedAt=typeof status?.health?.checkedAt==='string'&&Number.isFinite(Date.parse(status.health.checkedAt))?status.health.checkedAt:null;
  const code=typeof status?.health?.errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(status.health.errorCode)?status.health.errorCode:undefined;
  return {service:service.config.writesEnabled?'threads-mcp-controlled':'threads-mcp-readonly',writesEnabled:service.config.writesEnabled,revision:'remote-health-1',http:'up',bridge:{state,checkedAt,...(code?{errorCode:code}:{})},browser:{connected:status?.connected===true},externalPath:'not-probed',
    interpretation:'HTTP is reachable here. Browser connection does not prove login or page readiness. Diagnose tunnel and unavailable HTTP locally; this endpoint cannot observe its own external outage.'};
}
