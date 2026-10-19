// Runs only in the manually dispatched GitHub workflow; no Wrangler installation.
import {readFile} from 'node:fs/promises';
const required=['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','DEEPL_API_KEY','TURNSTILE_SECRET'];
for(const name of required)if(!process.env[name])throw new Error(`Configure the ${name} GitHub secret/variable before deployment.`);
if(process.env.CONFIRM_FREE_PLAN!=='true')throw new Error('Confirm that this account is on Workers Free; this script never changes billing plans.');
if(!process.env.DEEPL_API_KEY.endsWith(':fx'))throw new Error('Only a DeepL API Free key is accepted.');
const config=JSON.parse(await readFile('worker/wrangler.jsonc','utf8'));
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!/^[a-f0-9]{32}$/.test(account))throw new Error('Invalid Cloudflare account ID.');
const base=`https://api.cloudflare.com/client/v4/accounts/${account}/workers`;
async function api(path,options={}){
 const result=await fetch(base+path,{...options,headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,...options.headers},signal:AbortSignal.timeout(60000)});
 if(result.status===404&&options.method===undefined)return null;
 if(!result.ok)throw new Error(`Cloudflare request failed with HTTP ${result.status}. Check token scope and account configuration in the dashboard.`);
 const data=await result.json();if(!data.success)throw new Error('Cloudflare rejected deployment. Check the account dashboard.');return data.result;
}
const settings=await api(`/scripts/${config.name}/settings`);
const metadata={main_module:'index.js',compatibility_date:config.compatibility_date,observability:{enabled:false},bindings:[
 ...Object.entries(config.vars).map(([name,text])=>({type:'plain_text',name,text})),
 {type:'secret_text',name:'DEEPL_API_KEY',text:process.env.DEEPL_API_KEY},
 {type:'secret_text',name:'TURNSTILE_SECRET',text:process.env.TURNSTILE_SECRET},
 {type:'durable_object_namespace',name:'BUDGET',class_name:'TranslationBudget'}
]};
if(!settings)metadata.migrations={new_tag:'v1',new_sqlite_classes:['TranslationBudget']};
const form=new FormData();form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));form.append('index.js',new Blob([await readFile('worker/index.js','utf8')],{type:'application/javascript+module'}),'index.js');
await api(`/scripts/${config.name}`,{method:'PUT',body:form});
await api(`/scripts/${config.name}/subdomain`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true,previews_enabled:false})});
const domain=await api('/subdomain');
if(!domain?.subdomain)throw new Error('Set up the free workers.dev subdomain in the Cloudflare dashboard.');
console.log(`Worker deployed: https://${config.name}.${domain.subdomain}.workers.dev/translate`);
console.log('Set TRANSLATION_ENDPOINT and TURNSTILE_SITE_KEY as public GitHub repository variables, then run the Pages workflow. Never put provider keys into either variable.');
