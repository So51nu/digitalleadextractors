require('dotenv').config();
const express=require('express'),cors=require('cors');
const {chromium}=require('playwright');
const {genericScrape,websiteScrape,sourceLabel}=require('./scrapers/generic');
const {extractMaps}=require('./server-google-deep');

const app=express();
app.use(cors());
app.use(express.json({limit:'40mb'}));

const PORT=Number(process.env.PORT||3002);
const KEY=process.env.LEADOS_API_KEY||'';
const APP=process.env.APP_API_URL||'';
const HEADLESS=String(process.env.HEADLESS||'true').toLowerCase()!=='false';
const BATCH=Number(process.env.SAVE_BATCH_SIZE||20);
const active=new Set();
const allowed=new Set(['google_maps','justdial','indiamart','tradeindia','sulekha','website','instagram','facebook']);

function normSource(v){v=String(v||'google_maps').trim().toLowerCase();return allowed.has(v)?v:'google_maps';}
function auth(req,res,next){const k=req.headers['x-api-key']||req.headers['X-API-Key']||req.query.api_key;if(!KEY||k!==KEY)return res.status(401).json({ok:false,error:'Unauthorized'});next()}
async function php(action,payload={}){const r=await fetch(APP,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':KEY,'x-api-key':KEY},body:JSON.stringify({action,...payload})});const t=await r.text();let j;try{j=JSON.parse(t)}catch{throw new Error('PHP non JSON: '+t.slice(0,250))}if(!r.ok||!j.ok)throw new Error(j.detail||j.error||'PHP API failed');return j}
async function log(job_id,level,message){console.log(`[${job_id}] ${level}: ${message}`);try{await php('update_job',{job_id,log:message,level})}catch(e){}}

async function run(job_id){
  if(active.has(job_id))return;
  active.add(job_id);
  let browser;
  try{
    await php('update_job',{job_id,status:'running',progress:3,log:'Enterprise worker accepted job',level:'success'});
    const {job}=await php('get_job',{job_id});
    const source=normSource(job.source);
    job.source=source;
    await log(job_id,'info','VERIFIED source from database: '+source);
    await log(job_id,'info','Running selected source: '+sourceLabel(source));

    // Google Maps uses the proven Parallel V7 Maps engine, not the simple generic fallback.
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
    for(let i=0;i<leads.length;i+=BATCH){
      const batch=leads.slice(i,i+BATCH);
      const r=await php('save_leads',{job_id,leads:batch,total_found:leads.length});
      total=Number(r.total_saved||r.saved||total||0);
      await php('update_job',{job_id,status:'running',progress:Math.min(95,Math.round(((i+batch.length)/Math.max(leads.length,1))*90)),total_found:leads.length,total_saved:total,saved:total});
    }
    await php('update_job',{job_id,status:'completed',progress:100,total_found:leads.length,total_saved:total,saved:total,log:`${sourceLabel(source)} completed. Found ${leads.length}, saved ${total}.`,level:'success'});
  }catch(e){
    await php('update_job',{job_id,status:'failed',progress:100,error_message:e.message,log:'Job failed: '+e.message,level:'error'}).catch(()=>{});
  }finally{
    if(browser)await browser.close().catch(()=>{});
    active.delete(job_id);
  }
}

app.get('/health',(req,res)=>res.json({ok:true,service:'LeadOS Enterprise Multi Source Worker VERIFIED',port:PORT,selected_source_routing:true,google_engine:'Parallel V7 integrated',sources:[...allowed],active:[...active]}));
app.post('/run-job',auth,(req,res)=>{const id=Number(req.body.job_id||req.query.job_id);if(!id)return res.status(400).json({ok:false,error:'job_id required'});run(id);res.json({ok:true,queued:true,job_id:id,worker:'enterprise-verified'});});
app.listen(PORT,'0.0.0.0',()=>console.log('LeadOS Enterprise VERIFIED worker on '+PORT));
