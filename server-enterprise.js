require('dotenv').config();
const express=require('express'),cors=require('cors');
const {chromium}=require('playwright');
const {genericScrape,websiteScrape,sourceLabel}=require('./scrapers/generic');
const {extractMaps}=require('./server-google-deep');

const app=express();
app.use(cors());
app.use(express.json({limit:'40mb'}));

const PORT=Number(process.env.PORT||3002);
const KEY=String(process.env.LEADOS_API_KEY||'').trim();
const APP=String(process.env.APP_API_URL||'').trim();
const HEADLESS=String(process.env.HEADLESS||'true').toLowerCase()!=='false';
const BATCH=Number(process.env.SAVE_BATCH_SIZE||20);
const POLL_ENABLED=String(process.env.POLL_ENABLED||'true').toLowerCase()!=='false';
const POLL_MS=Number(process.env.POLL_MS||5000);
const FAIL_ON_ZERO=String(process.env.FAIL_ON_ZERO_LEADS||'true').toLowerCase()!=='false';
const FORCE_SAVE_PUBLIC_ROWS=String(process.env.FORCE_SAVE_PUBLIC_ROWS||'true').toLowerCase()!=='false';
const active=new Set();
const allowed=new Set(['google_maps','justdial','indiamart','tradeindia','sulekha','website','instagram','facebook']);
let pollBusy=false;

function normSource(v){v=String(v||'').trim().toLowerCase();return allowed.has(v)?v:'google_maps';}
function auth(req,res,next){const k=req.headers['x-api-key']||req.headers['X-API-Key']||req.query.api_key;if(!KEY||k!==KEY)return res.status(401).json({ok:false,error:'Unauthorized'});next()}
function apiUrl(action){
  const u = new URL(APP);
  if (KEY) u.searchParams.set('api_key', KEY);
  if (action) u.searchParams.set('action', action);
  return u.toString();
}
async function php(action,payload={}){
  if(!APP) throw new Error('APP_API_URL missing in .env');
  const url = apiUrl(action);
  const body = {action, api_key: KEY, ...payload};
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':KEY,'Authorization':'Bearer '+KEY},body:JSON.stringify(body)});
  const t=await r.text();let j;try{j=JSON.parse(t)}catch{throw new Error('PHP non JSON: '+t.slice(0,250))}
  if(!r.ok||!j.ok)throw new Error(j.detail||j.error||'PHP API failed');return j
}
async function log(job_id,level,message){console.log(`[${job_id}] ${level}: ${message}`);try{await php('update_job',{job_id,log:message,level})}catch(e){console.log(`[${job_id}] log-send-failed: ${e.message}`)}}

async function run(job_id){
  job_id=Number(job_id);
  if(!job_id||active.has(job_id))return;
  active.add(job_id);
  let browser;
  try{
    await php('update_job',{job_id,status:'running',progress:3,log:'Enterprise worker accepted job on port '+PORT,level:'success'});
    const {job}=await php('get_job',{job_id});
    if(!job) throw new Error('Job not found from PHP API');
    const source=normSource(job.source);
    job.source=source;
    await log(job_id,'info','VERIFIED source from database: '+source);
    await log(job_id,'info','Running selected source: '+sourceLabel(source));

    if(source==='google_maps'){
      const saved=await extractMaps(job, job_id);
      await php('update_job',{job_id,status:'completed',progress:100,saved,total_saved:saved,log:'Google Maps Parallel V7 completed. Saved '+saved+' leads.',level:'success'});
      return;
    }

    browser=await chromium.launch({headless:HEADLESS,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']});
    let leads=[];
    if(source==='website') leads=await websiteScrape({browser,job,log:(l,m)=>log(job_id,l,m)});
    else leads=await genericScrape({browser,job,log:(l,m)=>log(job_id,l,m)});

    let total=0;
    if(!leads.length){
      const msg=`${sourceLabel(source)} finished but no saveable leads were found. This source may be blocked/restricted or current filters require phone/website data that was not visible publicly.`;
      await php('update_job',{job_id,status:FAIL_ON_ZERO?'failed':'completed',progress:100,total_found:0,total_saved:0,saved:0,error_message:msg,log:msg,level:FAIL_ON_ZERO?'error':'warning'});
      return;
    }
    for(let i=0;i<leads.length;i+=BATCH){
      const batch=leads.slice(i,i+BATCH).map(x=>({...x,source}));
      const r=await php('save_leads',{job_id,leads:batch,total_found:leads.length,force_save:(source!=='google_maps' && FORCE_SAVE_PUBLIC_ROWS)});
      total=Number(r.total_saved||r.saved||total||0);
      await php('update_job',{job_id,status:'running',progress:Math.min(95,Math.round(((i+batch.length)/Math.max(leads.length,1))*90)),total_found:leads.length,total_saved:total,saved:total,log:`Saved batch ${i+batch.length}/${leads.length}. Total saved ${total}`,level:'success'});
    }
    if(total<=0){
      const msg=`${sourceLabel(source)} extracted ${leads.length} raw rows but 0 leads were saved. Check phone-only/website-only filters, duplicate rows, or database insert columns.`;
      await php('update_job',{job_id,status:FAIL_ON_ZERO?'failed':'completed',progress:100,total_found:leads.length,total_saved:0,saved:0,error_message:msg,log:msg,level:FAIL_ON_ZERO?'error':'warning'});
    } else {
      await php('update_job',{job_id,status:'completed',progress:100,total_found:leads.length,total_saved:total,saved:total,log:`${sourceLabel(source)} completed. Found ${leads.length}, saved ${total}.`,level:'success'});
    }
  }catch(e){
    console.error(`[${job_id}] FAILED`,e);
    await php('update_job',{job_id,status:'failed',progress:100,error_message:e.message,log:'Job failed: '+e.message,level:'error'}).catch(err=>console.error('failed to notify PHP',err.message));
  }finally{
    if(browser)await browser.close().catch(()=>{});
    active.delete(job_id);
  }
}

async function pollQueuedJobs(){
  if(!POLL_ENABLED || pollBusy) return;
  pollBusy=true;
  try{
    const r=await php('next_job',{});
    if(r.job && r.job.id){
      const id=Number(r.job.id);
      if(!active.has(id)){
        console.log(`[poll] picked queued job ${id} source=${r.job.source}`);
        run(id);
      }
    }
  }catch(e){
    console.log('[poll] PHP API not reachable or next_job failed:', e.message);
  }finally{pollBusy=false;}
}

app.get('/health',(req,res)=>res.json({ok:true,service:'LeadOS Enterprise Multi Source Worker POLLING VERIFIED PUBLIC CONTACT CRAWLER ENHANCED',port:PORT,app_api_url:APP,polling:POLL_ENABLED,poll_ms:POLL_MS,fail_on_zero_leads:FAIL_ON_ZERO,force_save_public_rows:FORCE_SAVE_PUBLIC_ROWS,selected_source_routing:true,google_engine:'Parallel V7 integrated',sources:[...allowed],active:[...active]}));
app.post('/run-job',auth,(req,res)=>{const id=Number(req.body.job_id||req.query.job_id);if(!id)return res.status(400).json({ok:false,error:'job_id required'});run(id);res.json({ok:true,queued:true,job_id:id,worker:'enterprise-polling-verified'});});
app.listen(PORT,'0.0.0.0',()=>{
  console.log('LeadOS Enterprise POLLING VERIFIED worker on '+PORT);
  console.log('APP_API_URL='+APP);
  console.log('POLL_ENABLED='+POLL_ENABLED+' POLL_MS='+POLL_MS);
  if(POLL_ENABLED) setInterval(pollQueuedJobs,POLL_MS);
});
