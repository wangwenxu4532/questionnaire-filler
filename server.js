// Wjx Questionnaire Filler v2.1 - Cookie+Session Proxy Server
const express = require('express');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wjx-v2-' + uuidv4().slice(0, 8);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Random China IP generator
function randomIP() {
    const r = [[1,2,4,0,255],[27,0,0,0,255],[36,0,0,0,255],[42,0,0,0,255],[49,0,0,0,255],[58,0,0,0,255],[61,0,0,0,255],
        [101,0,0,0,255],[106,0,0,0,255],[110,0,0,0,255],[125,0,0,0,255],[171,0,0,0,255],[175,0,0,0,255],
        [180,0,0,0,255],[183,0,0,0,255],[202,0,0,0,255],[203,0,0,0,255],[210,0,0,0,255],[211,0,0,0,255],[218,0,0,0,255]];
    const x = r[Math.floor(Math.random() * r.length)];
    return `${x[0]}.${x[1]+Math.floor(Math.random()*(x[2]-x[1]+1))}.${Math.floor(Math.random()*256)}.${1+Math.floor(Math.random()*254)}`;
}
let sessionIP = randomIP();
function getIP() { sessionIP = randomIP(); return sessionIP; }
function randUA() { return [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36',
][Math.floor(Math.random()*7)]; }

// DB
const { userGet,userGetById,userCreate,userAddCredits,userConsumeCredit,
    creditLogAdd,orderCreate,orderGetById,orderGetByUser,orderGetPending,orderUpdateStatus,
    announceGetActive,announceCreate,settingGet,settingSet,settingGetAll,
    dailyFreeGet,dailyFreeSet,calculatePrice } = require('./db');

// JWT middleware
function auth(req,res,next) { const t=req.headers.authorization?.replace('Bearer ',''); if(!t)return res.status(401).json({error:'请先登录'}); try{req.u=jwt.verify(t,JWT_SECRET);next()}catch(e){res.status(401).json({error:'登录过期'})} }
function adm(req,res,next) { if(req.u.role!=='admin')return res.status(403).json({error:'需要管理员'}); next(); }

// ── Auth ──
app.post('/api/auth/register',(req,res)=>{
    try{const{username,password}=req.body;if(!username||!password)return res.status(400).json({error:'输入用户名密码'});if(username.length<3||password.length<6)return res.status(400).json({error:'用户名>3位,密码>6位'}); if(userGet(username))return res.status(400).json({error:'用户名已存在'}); const u=userCreate(username,bcrypt.hashSync(password,10)); if(!u)return res.status(500).json({error:'注册失败'}); const fq=parseInt(settingGet('daily_free_quota','3'));userAddCredits(u.id,fq);creditLogAdd(u.id,fq,'free_daily','注册赠送');const token=jwt.sign({id:u.id,username,role:u.role},JWT_SECRET,{expiresIn:'7d'});res.json({success:true,token,user:{id:u.id,username,role:u.role,credits:fq}})}catch(e){res.status(500).json({error:'注册失败'})}
});
app.post('/api/auth/login',(req,res)=>{
    try{const{username,password}=req.body;const u=userGet(username);if(!u||!bcrypt.compareSync(password,u.password_hash))return res.status(400).json({error:'用户名或密码错误'});grantDaily(u.id);const nu=userGetById(u.id);const token=jwt.sign({id:nu.id,username:nu.username,role:nu.role},JWT_SECRET,{expiresIn:'7d'});res.json({success:true,token,user:{id:nu.id,username:nu.username,role:nu.role,credits:nu.credits,totalUsed:nu.total_used}})}catch(e){res.status(500).json({error:'登录失败'})}
});
app.get('/api/auth/me',auth,(req,res)=>{grantDaily(req.u.id);const u=userGetById(req.u.id);if(!u)return res.status(404).json({error:'不存在'});res.json({id:u.id,username:u.username,role:u.role,credits:u.credits,totalUsed:u.total_used})});
function grantDaily(uid){const today=new Date().toLocaleDateString('zh');if(dailyFreeGet(uid)!==today){const u=userGetById(uid),fq=parseInt(settingGet('daily_free_quota','3'));if(u&&u.credits<fq){const nd=fq-u.credits;if(nd>0){userAddCredits(uid,nd);creditLogAdd(uid,nd,'free_daily','每日免额补充')}}dailyFreeSet(uid,today)}}

// ── Pricing ──
app.get('/api/pricing',(req,res)=>{res.json({dailyFree:parseInt(settingGet('daily_free_quota','3')),unitPrice:'10元/100次+送10次',minBuy:parseInt(settingGet('min_buy_amount','100')),presets:[{amount:100,price:'10.00',bonus:10,receive:110},{amount:200,price:'20.00',bonus:20,receive:220,label:'推荐'},{amount:400,price:'40.00',bonus:40,receive:440}],formula:'100次=10元+送10次=实得110次'})});
app.post('/api/orders/create',auth,(req,res)=>{
    try{const{amount,paymentNote}=req.body;const p=calculatePrice(amount);const o=orderCreate(req.u.id,p.amount,p.priceCents,paymentNote||'');console.log(`[订单]${req.u.username} #${o.id}:${p.amount}份 ${p.yuan}元(赠${p.bonus}次)`);res.json({success:true,order:o,pricing:p,paymentInfo:{method:settingGet('payment_method',''),qrcode:settingGet('payment_qrcode',''),instructions:settingGet('payment_instructions','')}})}catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/orders/self-confirm',auth,(req,res)=>{
    try{const{orderId}=req.body;const o=orderGetById(orderId);if(!o)return res.status(404).json({error:'订单不存在'});if(o.user_id!==req.u.id)return res.status(403).json({error:'只能自己的'});if(o.status!=='pending')return res.status(400).json({error:'已处理'});const el=Date.now()-new Date(o.created_at).getTime();if(el<2000)return res.status(400).json({error:'稍后再确认'});orderUpdateStatus(orderId,'paid',null,'自助确认');const bonus=Math.floor(o.amount/100)*10;const total=o.amount+bonus;userAddCredits(o.user_id,total);creditLogAdd(o.user_id,total,'purchase',`订单#${orderId} 自助(${o.amount}+赠${bonus}=${total}次)`,orderId);const nu=userGetById(req.u.id);console.log(`[自助]${req.u.username}#${orderId}得${total}次`);res.json({success:true,message:`获得${total}次(赠${bonus}次)`,credits:nu.credits})}catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/orders/my',auth,(req,res)=>{res.json({success:true,orders:orderGetByUser(req.u.id)})});
app.get('/api/credits/log',auth,(req,res)=>{res.json({success:true,logs:[]})});
app.get('/api/public-settings',(req,res)=>{res.json({siteName:settingGet('site_name',''),dailyFree:parseInt(settingGet('daily_free_quota','3')),priceYuan:'10',minBuy:parseInt(settingGet('min_buy_amount','100')),paymentQrcode:settingGet('payment_qrcode',''),paymentInstructions:settingGet('payment_instructions','')})});
app.get('/api/announcements',(req,res)=>{res.json({success:true,announcement:announceGetActive()})});

// ── Admin ──
app.get('/api/admin/orders/pending',auth,adm,(req,res)=>{res.json({success:true,orders:orderGetPending()})});
app.post('/api/admin/orders/approve',auth,adm,(req,res)=>{
    try{const{orderId,adminNote}=req.body;const o=orderGetById(orderId);if(!o||o.status!=='pending')return res.status(400).json({error:'状态错误'});orderUpdateStatus(orderId,'paid',req.u.id,adminNote||'');const bonus=Math.floor(o.amount/100)*10;const total=o.amount+bonus;userAddCredits(o.user_id,total);creditLogAdd(o.user_id,total,'purchase',`#${orderId}(${o.amount}+赠${bonus})`,orderId);console.log(`[管理审核]#${orderId}通过`);res.json({success:true,message:`已到账${total}次`})}catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/admin/orders/reject',auth,adm,(req,res)=>{try{const{orderId,adminNote}=req.body;orderUpdateStatus(orderId,'cancelled',req.u.id,adminNote||'');res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/grant-credits',auth,adm,(req,res)=>{try{const{username,amount,note}=req.body;const u=userGet(username);if(!u)return res.status(404).json({error:'用户不存在'});const a=parseInt(amount)||0;userAddCredits(u.id,a);creditLogAdd(u.id,a,'admin_grant',note||'管理员操作');res.json({success:true,message:`已给${username}${a>0?'+':''}${a}次`})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/admin/settings',auth,adm,(req,res)=>{res.json({success:true,settings:settingGetAll()})});
app.post('/api/admin/settings',auth,adm,(req,res)=>{try{for(const[k,v]of Object.entries(req.body))settingSet(k,String(v));res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/announce',auth,adm,(req,res)=>{try{const{title,content}=req.body;announceCreate(title,content);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});

// ── Core: Analyze ──
app.post('/api/analyze',auth,async(req,res)=>{
    try{const{url,html:pHtml}=req.body;grantDaily(req.u.id);
        // Pasted HTML path
        if(pHtml&&pHtml.length>200&&(pHtml.includes('div_question')||pHtml.includes('jqRadio')||pHtml.includes('fieldset')||pHtml.includes('<input'))){
            const doc=new JSDOM(pHtml).window.document;
            const qs=parseQs(doc);console.log(`[分析-粘贴]${req.u.username}:${qs.length}题`);
            return res.json({success:true,title:doc.querySelector('title')?.textContent||'问卷',questionCount:qs.length,questions:qs,submitUrl:getSubmitUrl(doc,url||''),hiddenFields:getHidden(doc),rawHtml:pHtml});}
        if(!url)return res.status(400).json({error:'请提供链接或粘贴源码'});
        const mirrors=[url];if(url.includes('wjx.cn')){mirrors.push(url.replace('www.wjx.cn','ks.wjx.top'),url.replace('wjx.cn','ks.wjx.top'))}
        for(const mu of mirrors){try{const resp=await axios.get(mu,{headers:{'User-Agent':randUA(),'Accept':'text/html,*/*','Accept-Language':'zh,en;q=0.9','Referer':'https://www.wjx.cn/','Cookie':'acw_tc=ac'},timeout:20000,maxRedirects:5,validateStatus:s=>s<500});const h=resp.data;if(typeof h==='string'&&(h.includes('div_question')||h.includes('jqRadio')||h.includes('fieldset'))){const doc=new JSDOM(h).window.document;const qs=parseQs(doc);console.log(`[分析-代理]${req.u.username}:${qs.length}题`);return res.json({success:true,title:doc.querySelector('title')?.textContent||'问卷',questionCount:qs.length,questions:qs,submitUrl:getSubmitUrl(doc,mu),hiddenFields:getHidden(doc),rawHtml:h})}}catch(e){console.log(`[分析]镜像${mu}:${e.message}`)}}
        return res.json({success:true,title:'需粘贴源码',questionCount:0,questions:[],submitUrl:url,hiddenFields:{},needPasteHtml:true,hint:'服务器无法访问问卷，请右键→查看源代码→全选复制→粘贴到下方'})}
    catch(e){res.status(500).json({error:e.message})}
});

// ── Core: Batch Submit ──
app.post('/api/batch-submit',auth,async(req,res)=>{
    try{const{submitUrl,formDataTemplate,count,delay,referer,questions,customConfig,answerMode,rawHtml}=req.body;
        if(!submitUrl)return res.status(400).json({error:'缺少URL'});
        grantDaily(req.u.id);const user=userGetById(req.u.id);
        const total=Math.min(count||1,500);if(user.credits<total)return res.status(402).json({error:'次数不足',credits:user.credits,need:total});
        if(!userConsumeCredit(user.id,total))return res.status(402).json({error:'扣次失败'});
        creditLogAdd(user.id,-total,'consume',`批量提交${total}份`);
        const delayMs=Math.max(delay||500,200);
        let baseFields=formDataTemplate||{};
        if(rawHtml&&rawHtml.includes('div_question')){try{const doc=new JSDOM(rawHtml).window.document;baseFields={...getHidden(doc),...baseFields}}catch(_){}}
        let cookies='';try{const gr=await axios.get(submitUrl,{headers:{'User-Agent':randUA(),'Accept':'text/html,*/*','Accept-Language':'zh,en;q=0.9','Referer':'https://www.wjx.cn/'},timeout:15000,maxRedirects:5});const sc=gr.headers['set-cookie'];if(sc)cookies=(Array.isArray(sc)?sc:[sc]).map(c=>c.split(';')[0]).join('; ');console.log(`[Cookie]${cookies.slice(0,60)}`)}catch(e){console.log(`[Cookie]失败:${e.message}`)}
        console.log(`[批量]${user.username}提交${total}份`);
        res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');
        let ok=0,fail=0;
        for(let i=0;i<total;i++){const ip=getIP(),ua=randUA();try{
            let fd;if(answerMode==='custom'&&customConfig)fd=appCfg({...baseFields},customConfig,questions);else if(answerMode==='mixed'&&customConfig){fd=genAns({...baseFields},questions);fd=mergeCfg(fd,customConfig,questions)}else fd=genAns({...baseFields},questions);
            const params=new URLSearchParams();Object.entries(fd).forEach(([k,v])=>{if(Array.isArray(v))v.forEach(x=>params.append(k,x));else params.append(k,v)});
            const hdrs={'Content-Type':'application/x-www-form-urlencoded','Accept':'*/*','Accept-Language':'zh,en;q=0.9','Origin':new URL(submitUrl).origin,'Referer':submitUrl,'X-Requested-With':'XMLHttpRequest','X-Forwarded-For':ip,'X-Real-IP':ip,'User-Agent':ua};if(cookies)hdrs['Cookie']=cookies;
            const resp=await axios.post(submitUrl,params.toString(),{headers:hdrs,timeout:20000,maxRedirects:3});
            const rd=typeof resp.data==='string'?resp.data:JSON.stringify(resp.data);
            const isOk=resp.status===200&&(rd.length<2000||rd.includes('成功')||rd.includes('提交')||rd.includes('谢谢')||rd.includes('success')||rd.includes('true'));isOk?ok++:fail++;
            res.write(`data:${JSON.stringify({type:'progress',current:i+1,total,success:ok,fail,percent:Math.round((i+1)/total*100),ip})}\n\n`);
        }catch(e){fail++;res.write(`data:${JSON.stringify({type:'progress',current:i+1,total,success:ok,fail,percent:Math.round((i+1)/total*100),lastError:e.message,ip})}\n\n`)}
        if(i<total-1)await s(delayMs)}
        const nu=userGetById(user.id);res.write(`data:${JSON.stringify({type:'complete',total,success:ok,fail})}\n\n`);res.write(`data:${JSON.stringify({type:'credits',credits:nu.credits})}\n\n`);console.log(`[批量完成]${user.username}:${ok}/${total}`);res.end()
    }catch(e){console.error(e);if(!res.headersSent)res.status(500).json({error:e.message});else{res.write(`data:${JSON.stringify({type:'error',error:e.message})}\n\n`);res.end()}}
});

// ── Core: consume-credits ──
app.post('/api/consume-credits',auth,(req,res)=>{try{const{count=1}=req.body;grantDaily(req.u.id);const u=userGetById(req.u.id);const n=Math.min(count,500);if(u.credits<n)return res.status(402).json({error:'次数不足',credits:u.credits});if(!userConsumeCredit(u.id,n))return res.status(402).json({error:'扣次失败'});creditLogAdd(u.id,-n,'consume',`前端提交${n}份`);const nu=userGetById(u.id);res.json({success:true,credits:nu.credits,consumed:n})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/health',(req,res)=>{res.json({status:'ok',uptime:process.uptime(),ip:getIP()})});

// ── Parsing functions ──
function parseQs(doc){const qs=[],cs=findCs(doc);cs.forEach((c,i)=>{const t=detT(c);if(t==='unknown')return;const ti=exTi(c);if(!ti||ti.length<2)return;qs.push({index:i+1,type:t,title:ti.slice(0,120),options:exOp(c,t),fieldName:exFn(c,t)})});return qs}
function findCs(doc){for(const s of['.div_question','fieldset','.question','.field','[id^="divquestion"]','.topic']){const els=doc.querySelectorAll(s);if(els.length>=2)return Array.from(els)}return[]}
function detT(c){const h=c.innerHTML||'';if(h.includes('sortrank'))return'sort';if(h.includes('rate_off')||h.includes('rate_on'))return'star';if(h.includes('jqCheckbox')||c.querySelector('input[type="checkbox"]'))return'checkbox';if(h.includes('jqRadio')||c.querySelector('input[type="radio"]'))return'radio';if(c.querySelector('select'))return'select';if(c.querySelector('textarea'))return'textarea';if(c.querySelector('input[type="text"],input:not([type])'))return'text';return'unknown'}
function exTi(c){for(const s of['.div_title_question','legend','.field-label','label:first-of-type']){const e=c.querySelector(s);if(e&&e.textContent.trim().length>1)return e.textContent.replace(/\s+/g,' ').trim()}return c.textContent.replace(/\s+/g,' ').trim().slice(0,100)}
function exOp(c,t){const o=[];if(t==='radio'){c.querySelectorAll('a.jqRadio').forEach((a,i)=>o.push({index:i,text:a.textContent.trim().slice(0,60),val:a.getAttribute('val')||String(i+1)}));if(!o.length)c.querySelectorAll('input[type="radio"]').forEach((inp,i)=>{const l=inp.closest('label')||inp.parentElement;o.push({index:i,text:(l?.textContent||'').replace(/\s+/g,' ').trim().slice(0,60),val:inp.value||String(i+1)})})}if(t==='checkbox'){c.querySelectorAll('a.jqCheckbox').forEach((a,i)=>o.push({index:i,text:a.textContent.trim().slice(0,60),val:a.getAttribute('val')||String(i+1)}));if(!o.length)c.querySelectorAll('input[type="checkbox"]').forEach((inp,i)=>{const l=inp.closest('label')||inp.parentElement;o.push({index:i,text:(l?.textContent||'').replace(/\s+/g,' ').trim().slice(0,60),val:inp.value||String(i+1)})})}return o}
function exFn(c,t){if(t==='radio'){const r=c.querySelector('input[type="radio"]');return r?.name||''}if(t==='checkbox'){const r=c.querySelector('input[type="checkbox"]');return r?.name||''}if(t==='text'||t==='textarea'){const r=c.querySelector('input[type="text"],input:not([type]),textarea');return r?.name||''}return''}
function getSubmitUrl(doc,u){const a=doc.querySelector('form')?.getAttribute('action');return a?new URL(a,u).href:u.replace(/\?.*$/,'')}
function getHidden(doc){const f={};doc.querySelectorAll('input[type="hidden"]').forEach(inp=>{const n=inp.getAttribute('name'),v=inp.getAttribute('value');if(n&&v)f[n]=v});return f}
function genAns(tpl,qs){const d={...tpl};if(!qs)return d;qs.forEach(q=>{const fn=q.fieldName;if(!fn)return;switch(q.type){case'radio':if(q.options.length)d[fn]=q.options[Math.floor(Math.random()*q.options.length)].val;break;case'checkbox':{const cnt=1+Math.floor(Math.random()*Math.min(3,q.options.length));const p=[...q.options].sort(()=>Math.random()-0.5).slice(0,cnt);const cl=fn.replace('[]','');fn.includes('[]')?(d[cl]=p.map(x=>x.val)):p.forEach((x,i)=>{d[`${cl}[${i}]`]=x.val});break}case'text':case'textarea':d[fn]=['体验不错','服务好功能全','使用体验良好','性价比不错','质量可靠'][Math.floor(Math.random()*5)];break;case'select':if(q.options.length)d[fn]=q.options[Math.floor(Math.random()*q.options.length)].val;break;case'star':d[fn]=String(3+Math.floor(Math.random()*3))}});return d}
function appCfg(t,cfg,qs){const d={...t};if(!qs)return d;qs.forEach(q=>{const fn=q.fieldName;if(!fn)return;const c=cfg[fn];if(!c)return;switch(q.type){case'radio':case'select':d[fn]=c.val||'';break;case'checkbox':{const cl=fn.replace('[]','');fn.includes('[]')?(d[cl]=c.vals||[]):(c.vals||[]).forEach((v,i)=>{d[`${cl}[${i}]`]=v});break}case'text':case'textarea':d[fn]=c.text||'';break;case'star':d[fn]=c.val||'4'}});return d}
function mergeCfg(r,cfg,qs){const d={...r};if(!qs)return d;qs.forEach(q=>{const fn=q.fieldName;if(!fn)return;const c=cfg[fn];if(!c)return;switch(q.type){case'radio':case'select':if(c.val)d[fn]=c.val;break;case'checkbox':if(c.vals?.length){const cl=fn.replace('[]','');fn.includes('[]')?(d[cl]=c.vals):c.vals.forEach((v,i)=>{d[`${cl}[${i}]`]=v})}break;case'text':case'textarea':if(c.text)d[fn]=c.text;break;case'star':if(c.val)d[fn]=c.val}});return d}
function s(ms){return new Promise(r=>setTimeout(r,ms))}

// ── Start ──
app.listen(PORT,()=>{console.log(`\n=== Wjx Filler v2.1 ===\nPort:${PORT}\nAdmin:admin/admin123\nFree daily:${settingGet('daily_free_quota','3')}\nPrice:10yuan/100+b10\nCookie+Session+CORS bypass enabled\n`)});
