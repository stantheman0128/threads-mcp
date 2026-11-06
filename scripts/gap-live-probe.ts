import {RemoteExtensionDriver} from '../src/remote-driver.js';
import {getConfig} from '../src/config.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const config=getConfig();const driver=new RemoteExtensionDriver({dataDir:config.dataDir});
try {
  await driver.connect();
  if(!driver.status().connected)throw new Error('Selected tab disconnected');
  if(process.argv[2])await driver.command({type:'navigate',url:process.argv[2]});
  const snapshot=await driver.command<any>({type:'snapshot'});
  writeFileSync(join(config.dataDir,'gap-probe.json'),JSON.stringify(snapshot,null,2));
  console.log(JSON.stringify({url:snapshot.url,controls:snapshot.elements.map((e:any)=>({role:e.role,name:e.name,href:e.href})).filter((e:any)=>/search|top|recent|profile|搜尋|熱門|最新|個人檔案/i.test(e.name)),accountObserved:!!snapshot.viewer.username}));
}finally{await driver.close();}
