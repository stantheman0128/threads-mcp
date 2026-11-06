import {RemoteExtensionDriver} from '../src/remote-driver.js';
import {ThreadsService} from '../src/service.js';
import {SearchIndex} from '../src/search.js';
import {getConfig} from '../src/config.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const config=getConfig();const driver=new RemoteExtensionDriver({dataDir:config.dataDir});const service=new ThreadsService(driver,new SearchIndex(config.dataDir),config);
try{
 await driver.connect();const page=await service.browserRead();const account=page.viewer.username;if(!account)throw new Error('No viewer');
 const currentCode=new URL(page.url).pathname.match(/\/@[\w.]+\/post\/([\w-]+)/)?.[1];
 let target=currentCode?page.posts.find(post=>post.code===currentCode):undefined;
 if(!target){const own=await service.profile(account,'posts',0);target=own.items.find(post=>post.code);if(!target)throw new Error('No target post');await service.browserRead(target.url);}
 const observation=await driver.command<any>({type:'social',operation:'inspect',request:{kind:'like',targetUrl:target.url}});
 const after=await service.browserRead();const report={status:'PASS',runtimeVersion:after.runtimeVersion,extensionVersion:after.extensionVersion??null,socialWritesPerformed:false,accountMatched:observation.account===account,targetMatched:observation.targetUrl===target.url,state:observation.state,visibility:after.visibilityState,observedAt:after.observedAt};
 if(!report.accountMatched||!report.targetMatched||observation.state==='unknown')throw new Error('Target state not established');
 writeFileSync(join(config.dataDir,'social-live-probe.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await service.close();}
