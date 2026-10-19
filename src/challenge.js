// Only load Turnstile after explicit translation consent. No provider keys here.
let scriptPromise;
export async function challengeToken(sitekey,signal) {
  if(!sitekey)return undefined;
  if(signal?.aborted)throw signal.reason;
  scriptPromise ||= new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.onload=resolve;script.onerror=()=>{scriptPromise=null;reject(new Error('Could not load human verification.'));};document.head.append(script);
  });
  await scriptPromise;
  if(signal?.aborted)throw signal.reason;
  return new Promise((resolve,reject)=>{
    let widget;
    const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);if(widget!==undefined)window.turnstile.remove(widget);};
    const finish=(fn,value)=>{cleanup();fn(value);};
    const abort=()=>finish(reject,new DOMException('Translation stopped','AbortError'));
    const timeout=setTimeout(()=>finish(reject,new Error('Human verification timed out. Please retry.')),120000);
    signal?.addEventListener('abort',abort,{once:true});
    widget=window.turnstile.render('#turnstile-widget',{sitekey,action:'reader-translate',callback:token=>finish(resolve,token),'error-callback':()=>finish(reject,new Error('Human verification failed.')),'expired-callback':abort});
  });
}
