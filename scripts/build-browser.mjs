import { build } from 'esbuild';
await build({entryPoints:['src/page-runtime.ts'],bundle:true,platform:'browser',format:'iife',globalName:'ThreadsMCP',outfile:'extension/runtime.js',target:'chrome120',legalComments:'none'});
