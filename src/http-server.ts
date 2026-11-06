import {createServer as createHttpServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {createServer} from './server.js';
import type {ThreadsService} from './service.js';
import type {BrowserDriver} from './driver.js';
import {ThreadsError} from './types.js';
import {remoteHealth} from './remote-health.js';
import {validateDirectProfileCommand} from './direct-profile-command.js';
import {RemoteSocialController} from './remote-social.js';

const MAX_BODY=64*1024;
const validToken=(value:string)=>/^[A-Za-z0-9_-]{43,128}$/.test(value);

/** The remote bearer is independent of the extension's pairing secret. Never log it. */
export function ensureRemoteToken(dataDir:string):string{
  mkdirSync(dataDir,{recursive:true});const path=join(dataDir,'remote-access.token');
  const marker=join(dataDir,'remote-access.initialized');
  // Deleting a token is revocation, including across automatic process restarts.
  if(!existsSync(path)&&existsSync(marker))return path;
  try{writeFileSync(path,randomBytes(32).toString('base64url'),{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  // Invalid existing files are never replaced silently; authenticated requests stay disabled.
  writeFileSync(marker,'Remote access was initialized. Missing token means revoked.\n',{mode:0o600});
  return path;
}

export function changeRemoteToken(dataDir:string,action:'rotate'|'revoke'){
  mkdirSync(dataDir,{recursive:true});
  writeFileSync(join(dataDir,'remote-access.initialized'),'Explicit token management; missing token means revoked.\n',{mode:0o600});
  const path=join(dataDir,'remote-access.token');
  if(action==='rotate')writeFileSync(path,randomBytes(32).toString('base64url'),{mode:0o600});
  else try{unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

/** Only approved read commands can reach the browser; never index a private/current arbitrary route. */
export class RemoteReadDriver implements BrowserDriver{
  constructor(private readonly driver:BrowserDriver){}
  status(){return this.driver.status();}
  async refreshStatus(){return this.driver.refreshStatus?this.driver.refreshStatus():this.driver.status();}
  async command<T>(command:Record<string,unknown>):Promise<T>{
    if(!['read','navigate','scroll','open_read_panel','direct_profile'].includes(String(command.type)))throw new ThreadsError('REMOTE_READ_ONLY','Unsupported remote browser operation.');
    if(command.type==='direct_profile')validateDirectProfileCommand(command);
    if(command.type==='navigate'&&!safeReadUrl(command.url))throw new ThreadsError('REMOTE_ROUTE_DENIED','Unsupported remote read route.');
    const result=await this.driver.command<any>(command);
    if(command.type==='read'){
      if(!safeReadUrl(result.url))throw new ThreadsError('REMOTE_ROUTE_DENIED','The selected tab is outside the remote read scope.');
      // Structured tools do not need page-wide text or private notification/composer metadata.
      result.text='';delete result.notificationRows;delete result.composerState;
    }
    return result as T;
  }
  close(){return this.driver.close();}
}
function safeReadUrl(value:unknown):boolean{
  if(typeof value!=='string')return false;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['threads.com','www.threads.com','threads.net','www.threads.net'].includes(u.hostname)&&
    /^(?:\/|\/(?:search|liked|saved)\/?|\/@[\w.]+(?:\/(?:replies|media|reposts))?\/?|\/(?:@[\w.]+\/)?post\/[\w-]+\/?)$/.test(u.pathname);
  }catch{return false;}
}

export async function startRemoteHttp(service:ThreadsService,options:{port:number;readToken:()=>string;controlledWrites?:boolean;socialDriver?:BrowserDriver}){
  if(service.config.writesEnabled!==!!options.controlledWrites)throw new Error('Remote HTTP writes require explicit matching controlled mode.');
  if(options.controlledWrites&&!options.socialDriver)throw new Error('Controlled mode requires a local context driver.');
  let credentialEpoch:string|undefined;
  let requestCredential:string|undefined;
  // Check again at controller dispatch boundaries, not only HTTP request arrival.
  const assertAccess=()=>{
    let current:string|undefined;try{current=options.readToken();}catch{}
    if(!current||!validToken(current)||current!==credentialEpoch||current!==requestCredential){
      social?.invalidatePrepared();
      throw new ThreadsError('ACCESS_CHANGED','Remote credentials changed; preparation is invalid.');
    }
  };
  const social=options.controlledWrites?new RemoteSocialController(service,options.socialDriver!,assertAccess):undefined;
  if(!Number.isInteger(options.port)||options.port<0||options.port>65535)throw new Error('Invalid remote HTTP port.');
  // A revoked/missing token leaves HTTP alive but fails closed, even under a supervisor.
  let busy=false;
  const send=(res:ServerResponse,status:number,error:string)=>{res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify({error}));};
  async function handle(req:IncomingMessage,res:ServerResponse){
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    // cloudflared must override Host to this exact loopback authority. No browser origins/CORS.
    const address=http.address();const port=typeof address==='object'&&address?address.port:options.port;
    if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin||req.headers['sec-fetch-site']==='cross-site'){send(res,403,'Forbidden');return;}
    let token:string;try{token=options.readToken();}catch{social?.invalidatePrepared();credentialEpoch=undefined;send(res,503,'Access disabled');return;}
    if(credentialEpoch!==token){social?.invalidatePrepared();credentialEpoch=token;}
    const auth=req.headers.authorization??'';const expected=`Bearer ${token}`;
    if(!validToken(token)){social?.invalidatePrepared();send(res,503,'Access disabled');return;}
    if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){
      res.setHeader('WWW-Authenticate','Bearer realm="threads-mcp"');send(res,401,'Unauthorized');return;
    }
    if(req.url==='/healthz'&&req.method==='GET'){
      const health=await remoteHealth(service,!busy);res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({...health,busy}));return;
    }
    if(req.url!=='/mcp'){send(res,404,'Not found');return;}
    if(req.method!=='POST'){res.setHeader('Allow','POST');send(res,405,'Use MCP JSON POST');return;}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){send(res,415,'JSON required');return;}
    if(Number(req.headers['content-length']??0)>MAX_BODY){send(res,413,'Request too large');return;}
    if(busy){res.setHeader('Retry-After','3');send(res,429,'Another remote read is in progress');return;}
    // Held through response-body completion, across all nested research operations.
    busy=true;requestCredential=token;let server:ReturnType<typeof createServer>|undefined;
    try{
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>MAX_BODY){send(res,413,'Request too large');return;}chunks.push(b);}
      const body=Buffer.concat(chunks).toString('utf8');let parsed:unknown;
      try{parsed=JSON.parse(body);}catch{send(res,400,'Invalid JSON');return;}
      // MCP JSON-RPC batches would introduce concurrent browser operations within one request.
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){send(res,400,'One MCP message per request is required');return;}
      // A slow request authenticated with A cannot inherit a later B credential epoch.
      let currentToken:string|undefined;try{currentToken=options.readToken();}catch{}
      if(currentToken!==token||credentialEpoch!==token){social?.invalidatePrepared();send(res,401,'Authorization changed');return;}
      server=createServer(service,{remoteReadOnly:!social,remoteSocial:social});
      const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:MAX_BODY});
      await server.connect(transport);
      const headers=new Headers();for(const name of ['accept','content-type','mcp-protocol-version','mcp-session-id']){const v=req.headers[name];if(typeof v==='string')headers.set(name,v);}
      const response=await transport.handleRequest(new Request(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers,body}));
      const output=Buffer.from(await response.arrayBuffer());
      res.statusCode=response.status;response.headers.forEach((v,k)=>res.setHeader(k,v));res.end(output);
    }catch{if(!res.headersSent)send(res,500,'Remote request failed');else res.end();}
    finally{await server?.close().catch(()=>{});requestCredential=undefined;busy=false;}
  }
  const http=createHttpServer({maxHeaderSize:16*1024,requestTimeout:15_000,headersTimeout:10_000},(req,res)=>{void handle(req,res).catch(()=>{if(!res.headersSent)send(res,500,'Remote request failed');else res.end();});});
  http.maxConnections=16;
  http.once('close',()=>social?.invalidatePrepared());
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(options.port,'127.0.0.1',()=>{http.off('error',reject);resolve();});});
  return http;
}
