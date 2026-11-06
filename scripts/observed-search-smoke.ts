import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getConfig} from '../src/config.js';
import {SearchIndex} from '../src/search.js';
const config=getConfig();const index=new SearchIndex(config.dataDir,{fallbackOnError:false});
try{
  const query='開源專案維護者有機會免費使用付費的人工智慧方案嗎';
  const result=await index.search(query,{mode:'semantic',limit:3});
  const report={observedAt:new Date().toISOString(),corpus:'Previously observed real Threads posts',query,method:result.method,corpusSize:result.corpusSize,items:result.items.map(x=>({url:x.post.url,score:x.score,lexicalScore:x.lexicalScore})),warnings:result.warnings};
  writeFileSync(join(config.dataDir,'observed-search-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await index.close();}
