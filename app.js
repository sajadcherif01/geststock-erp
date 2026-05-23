// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ UTILS â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
const $=id=>document.getElementById(id);
const uid=p=>`${p}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
const today=()=>new Date().toISOString().slice(0,10);
const num=v=>parseFloat(v)||0;
const intv=v=>parseInt(v)||0;
const norm=s=>(s||'').trim();
const dh=v=>num(v).toLocaleString('fr-MA',{minimumFractionDigits:2,maximumFractionDigits:2})+' DH';
const sqm=v=>num(v).toLocaleString('fr-MA',{minimumFractionDigits:2,maximumFractionDigits:2})+' m2';
const surface=(l,w,q)=>num(l)*num(w)*intv(q)/10000;
const keyOf=(a,c,l,w)=>`${norm(a)}|${norm(c)}|${num(l)}|${num(w)}`;
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr=h;
const deepClone=v=>JSON.parse(JSON.stringify(v));
let forcePwUser=null;

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ DB â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
const CKEYS=['articles','clients','suppliers','sites','purchases','sales','transfers','inventories','clientPrices','supplierPrices','payments','rolls','rollCuts'];
let db={articles:[],clients:[],suppliers:[],sites:[],purchases:[],sales:[],transfers:[],inventories:[],clientPrices:[],supplierPrices:[],payments:[],rolls:[],rollCuts:[]};
let sessionLines={purchase:[],sale:[],transfer:[],inventory:[],buyback:[]};
let edit={article:-1,client:-1,supplier:-1,site:-1,cp:-1,sp:-1};
let view={clientAccount:'',supplierAccount:''};
let confirmCallback=null;
let restoreData=null;
const DEFAULT_USERS=[
  {id:'u-admin',name:'admin',role:'admin',passwordHash:'03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'},
  {id:'u-visiteur',name:'visiteur',role:'visitor',passwordHash:'9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0'}
];
const DEFAULT_PASSWORD_HASHES=new Set(DEFAULT_USERS.map(u=>u.passwordHash));
let users=[];
let currentUser=null;
let currentRole='visitor';
let operationAuditLog=[];
let isApplyingRemote=false;
let lastRemoteUpdatedAt='';
let lastLocalUpdatedAt='';
let remoteUpdateCount=0;
let lastRemoteNotifTime=0;

let supabaseUrl=localStorage.getItem('gs3_supabase_url')||'';
let supabaseAnonKey=localStorage.getItem('gs3_supabase_anon_key')||'';
let supabaseClient=null;
let supabaseChannel=null;
let supabaseSaveTimer=null;
let supabaseSaveInProgress=false;
let isSavingToSupabase=false;
let debouncedRefreshTimer=null;
function debouncedRefresh(){clearTimeout(debouncedRefreshTimer);debouncedRefreshTimer=setTimeout(refresh,100)}
let pendingSupabaseSave=false;
const SUPABASE_STATE_ID='main';

// ===== INDEXED DB (fallback pour localStorage depasse) =====
const IDB_NAME='geststock',IDB_VER=1,IDB_STORE='kv';
let idbReady=false;
let idbDb=null;
function idbOpen(){
  return new Promise((res,rej)=>{
    if(idbReady&&idbDb){res(idbDb);return}
    try{
      const req=indexedDB.open(IDB_NAME,IDB_VER);
      req.onupgradeneeded=e=>{e.target.result.createObjectStore(IDB_STORE)};
      req.onsuccess=e=>{idbDb=e.target.result;idbReady=true;res(idbDb)};
      req.onerror=e=>{idbReady=false;rej(e.target.error)};
    }catch(e){idbReady=false;rej(e)}
  });
}
async function idbSave(key,value){
  try{const db=await idbOpen();const tx=db.transaction(IDB_STORE,'readwrite');tx.objectStore(IDB_STORE).put(value,key);await new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=rej})}catch(e){console.warn('IDB save fail',e)}
}
async function idbLoad(key){
  try{const db=await idbOpen();return await db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get(key)}catch(e){return undefined}
}

async function idbSaveAll(){
  if(!idbReady)return;
  try{
    const tx=idbDb.transaction(IDB_STORE,'readwrite');
    CKEYS.forEach(k=>tx.objectStore(IDB_STORE).put(JSON.stringify(db[k]||[]),'gs3_'+k));
    tx.objectStore(IDB_STORE).put(JSON.stringify(users),'gs3_users');
    tx.objectStore(IDB_STORE).put(lastLocalUpdatedAt,'gs3_updated_at');
    await new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=rej});
  }catch(e){console.warn('IDB saveAll fail',e)}
}
async function idbTryLoad(){
  try{
    await idbOpen();
    const tx=idbDb.transaction(IDB_STORE,'readonly');
    const store=tx.objectStore(IDB_STORE);
    const idbUpdated=await new Promise((res,rej)=>{const r=store.get('gs3_updated_at');r.onsuccess=()=>res(r.result);r.onerror=rej});
    if(idbUpdated&&(!lastLocalUpdatedAt||idbUpdated>lastLocalUpdatedAt)){
      for(const k of CKEYS){const v=await new Promise(r=>{const q=store.get('gs3_'+k);q.onsuccess=()=>r(q.result)});if(v)db[k]=JSON.parse(v)}
      const uv=await new Promise(r=>{const q=store.get('gs3_users');q.onsuccess=()=>r(q.result)});if(uv)users=JSON.parse(uv);
      lastLocalUpdatedAt=idbUpdated;
      save({touch:false,remote:false});refresh();
    }
  }catch(e){console.warn('IDB migrate check fail',e)}
}

// ===== PER-TABLE SUPABASE SYNC =====
const TABLE_MAP={
  articles:'geststock_articles',clients:'geststock_clients',suppliers:'geststock_suppliers',
  sites:'geststock_sites',purchases:'geststock_purchases',sales:'geststock_sales',
  transfers:'geststock_transfers',inventories:'geststock_inventories',
  clientPrices:'geststock_client_prices',supplierPrices:'geststock_supplier_prices',
  payments:'geststock_payments',rolls:'geststock_rolls',rollCuts:'geststock_roll_cuts'
};
const USERS_TABLE='geststock_users';
const TABLE_KEYS=Object.keys(TABLE_MAP);
let isSupabaseNewSchema=false;
function camelToSnake(s){return s.replace(/[A-Z]/g,m=>'_'+m.toLowerCase())}
function snakeToCamel(s){return s.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())}
function objToRow(tbl,obj){
  const row={};
  for(const[key,val]of Object.entries(obj)){
    if(key.startsWith('_'))continue;
    let col=camelToSnake(key);
    if(tbl==='geststock_transfers'){
      if(key==='from')col='from_site';
      if(key==='to')col='to_site';
    }
    if(key==='isBuyback'){
      if(val)row.note='[RACHAT]'+(row.note||'');
      continue;
    }
    row[col]=val;
  }
  return row;
}
function rowToObj(tbl,row){
  const obj={};
  for(const[key,val]of Object.entries(row)){
    if(key==='updated_at'){obj._updatedAt=val;continue}
    let jsKey=snakeToCamel(key);
    if(tbl==='geststock_transfers'){
      if(key==='from_site')jsKey='from';
      if(key==='to_site')jsKey='to';
    }
    obj[jsKey]=val;
  }
  if(tbl==='geststock_sales'&&(obj.note||'').startsWith('[RACHAT]')){
    obj.isBuyback=true;
    obj.note=obj.note.slice(8);
  }
  return obj;
}
function userToRow(u){return{id:u.id,name:u.name,role:u.role,password_hash:u.passwordHash,keep_online:!!u.keepOnline}}
function rowToUser(r){return{id:r.id,name:r.name,role:r.role,passwordHash:r.password_hash,_updatedAt:r.updated_at,keepOnline:!!r.keep_online}}
// ===== SAFE SYNC FIX =====
let isDataLoaded=false;

function isAdmin(){return currentRole==='admin'}
function isLoggedIn(){return !!currentUser}
function hasDefaultPasswordUser(){return users.some(u=>DEFAULT_PASSWORD_HASHES.has(u.passwordHash))}
function requireAdmin(){
  if(isAdmin())return true;
  notify('Action interdite. Connectez-vous avec un utilisateur Admin pour modifier les donnees.',true);
  return false;
}
function setLoggedUser(user,remember){
  currentUser=user?{id:user.id,name:user.name,role:user.role}:null;
  currentRole=currentUser?.role==='admin'?'admin':'visitor';
  const storage=remember?localStorage:sessionStorage;
  if(currentUser)storage.setItem('gs3_user',JSON.stringify(currentUser));
  else{localStorage.removeItem('gs3_user');sessionStorage.removeItem('gs3_user')}
  applyAccessMode();
}
async function sha256(text){
  const bytes=new TextEncoder().encode(text);
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function applyAccessMode(){
  document.body.classList.toggle('role-admin',isAdmin());
  document.body.classList.toggle('role-visitor',!isAdmin());
  const chip=$('role-chip');
  if(chip){
    chip.textContent=currentUser?`${currentUser.name} - ${isAdmin()?'Admin':'Visiteur'}`:'Non connecte';
    chip.className='role-chip '+(isAdmin()?'admin':'visitor');
  }
  const login=$('role-login'),logout=$('role-logout');
  if(login)login.style.display=currentUser?'none':'inline-flex';
  if(logout)logout.style.display=currentUser?'inline-flex':'none';
  const writeNames=['saveArticle','saveClient','saveSupplier','saveSite','saveClientPrice','saveSupplierPrice','saveUser','deleteUser','savePurchase','saveSale','saveBuyback','saveTransfer','saveInventory','saveAccountPayment','confirmSession','removeRow','removeSite','removeSessionLine','openEditLine','editOperationRow','deleteOperationRow','editPayment','deletePayment','setPaymentPaidStatus','togglePaymentPaid','restoreFromHistory','promptClientFee','createClientFee','editArticle','editClientRow','editSupplierRow','editSiteRow','editClientPrice','editSupplierPrice','clearForm','clearFormMv','clearFormInv','importExcelInventaire','confirmExcelInventaire','cancelExcelInventaire','applyResetStock','exportBackup','saveSupabaseConfig','manualSyncToSupabase','loadFromSupabase'];
  document.querySelectorAll('button').forEach(btn=>{
    const onclick=btn.getAttribute('onclick')||'';
    const id=btn.id||'';
    const text=(btn.textContent||'').toLowerCase();
    const isWrite=writeNames.some(name=>onclick.includes(name))||['reset-app','btn-reset-stock-modal','confirm-modal-ok','edit-line-save','effect-deduct-now','effect-wait-due','due-modal-paid','due-modal-unpaid'].includes(id)||/enregistrer|ajouter|modifier|supprimer|confirmer|reset|remise a zero|import|annuler ligne/.test(text);
    btn.classList.toggle('write-action',isWrite);
    if(!isAdmin()&&isWrite)btn.disabled=true;
    else btn.disabled=false;
  });
  document.querySelectorAll('.quick-entry input,.quick-entry select,.form-grid input,.form-grid select').forEach(el=>{
    const keepEnabled=['client-account-select','supplier-account-select','admin-code-input','login-name-input','supabase-url-input','supabase-key-input'].includes(el.id)||el.closest('#role-modal')||el.closest('[id$="-print-options"]');
    if(!isAdmin()&&!keepEnabled){
      el.setAttribute('readonly','readonly');
      if(el.tagName==='SELECT')el.disabled=true;
    }else{
      el.removeAttribute('readonly');
      if(el.tagName==='SELECT')el.disabled=false;
    }
  });
  updateSyncStatus();
}
function updateSyncStatus(state){
  const chip=$('sync-chip');
  if(!chip)return;
  let label='Supabase temps reel';
  let cls='sync-chip ok';
  if(state==='saving'){label='Sync envoi...';cls='sync-chip warn'}
  else if(state==='loading'){label='Sync lecture...';cls='sync-chip warn'}
  else if(state==='error'){label='Sync erreur';cls='sync-chip bad'}
  else if(!supabaseClient&&supabaseUrl){label='Supabase a verifier';cls='sync-chip warn'}
  else if(supabaseClient){
    label='Temps reel actif';
    if(remoteUpdateCount>0)label+=' ('+remoteUpdateCount+' maj)';
    cls='sync-chip ok';
  }
  chip.textContent=label;
  chip.className=cls;
  if(remoteUpdateCount>0)chip.title=remoteUpdateCount+' mise(s) a jour depuis un autre appareil';
}

function dataPayload(){
  if(!lastLocalUpdatedAt)lastLocalUpdatedAt=new Date().toISOString();
  return{version:'1.0',updatedAt:lastLocalUpdatedAt,users,data:Object.fromEntries(CKEYS.map(k=>[k,db[k]||[]]))};
}
function normalizePayload(payload){
  if(!payload||typeof payload!=='object')throw new Error('Format de sauvegarde invalide');
  const sourceData=payload.data&&typeof payload.data==='object'?payload.data:payload;
  const next={version:String(payload.version||'1.0'),updatedAt:payload.updatedAt||new Date().toISOString(),users:Array.isArray(payload.users)?payload.users:users,data:{}};
  CKEYS.forEach(k=>{next.data[k]=Array.isArray(sourceData[k])?sourceData[k]:[]});
  next.users=(next.users.length?next.users:DEFAULT_USERS).map(u=>({id:u.id||uid('usr'),name:String(u.name||'').trim().toLowerCase(),role:u.role==='admin'?'admin':'visitor',passwordHash:String(u.passwordHash||''),keepOnline:!!u.keepOnline})).filter(u=>u.name&&u.passwordHash);
  if(!next.users.length)next.users=DEFAULT_USERS;
  return next;
}
function applyDataPayload(payload){
  if(!payload)return;
  const clean=normalizePayload(payload);
  lastRemoteUpdatedAt=clean.updatedAt||lastRemoteUpdatedAt;
  users=clean.users;
  CKEYS.forEach(k=>{db[k]=clean.data[k]});
}
// ===== SAFE SYNC FIX =====
function dbHasAnyData(){return !Object.values(db).every(arr=>Array.isArray(arr)&&arr.length===0)}
function payloadHasAnyData(payload){return !!payload&&Object.values(payload.data||{}).some(arr=>Array.isArray(arr)&&arr.length>0)}
function canSyncData(){
  if(!isDataLoaded){console.warn('SYNC BLOCKED: data not loaded');return false;}
  if(!dbHasAnyData()){console.warn('SYNC BLOCKED: empty data');return false;}
  console.log('SYNC OK');
  return true;
}
function save(options={}){
  const {touch=!isApplyingRemote,remote=!isApplyingRemote}=options;
  try{
    if(touch){lastLocalUpdatedAt=new Date().toISOString();localStorage.setItem('gs3_updated_at',lastLocalUpdatedAt)}
    CKEYS.forEach(k=>localStorage.setItem('gs3_'+k,JSON.stringify(db[k]||[])));
    localStorage.setItem('gs3_users',JSON.stringify(users));
    if(remote)scheduleRemoteSave();
    idbSaveAll();
  }catch(e){console.warn('Local save failed',e);}
}
function load(){
  CKEYS.forEach(k=>{try{const v=localStorage.getItem('gs3_'+k);if(v)db[k]=JSON.parse(v)}catch(e){}});
  try{const u=localStorage.getItem('gs3_users');users=u?JSON.parse(u):DEFAULT_USERS}catch(e){users=DEFAULT_USERS}
  try{const logs=localStorage.getItem('gs3_operation_audit');operationAuditLog=logs?JSON.parse(logs):[]}catch(e){operationAuditLog=[]}
  try{lastLocalUpdatedAt=localStorage.getItem('gs3_updated_at')||lastLocalUpdatedAt}catch(e){}
  try{const su=sessionStorage.getItem('gs3_user')||localStorage.getItem('gs3_user');if(su){currentUser=JSON.parse(su);currentRole=currentUser.role==='admin'?'admin':'visitor'}}catch(e){}
  db.articles=(db.articles||[]).map(a=>({...a,type:a.type||'tapis'}));
  db.rolls=db.rolls||[];
  db.rollCuts=db.rollCuts||[];
  normalizePayments();
  isDataLoaded=true;
}

function scheduleRemoteSave(){
  if(supabaseClient){scheduleSupabaseSave();}
}

function initSupabase(){
  if(!supabaseUrl||!supabaseAnonKey||!window.supabase)return false;
  supabaseClient=window.supabase.createClient(supabaseUrl,supabaseAnonKey);
  updateSyncStatus();
  return true;
}
function saveSupabaseConfig(){
  if(!requireAdmin())return;
  const url=norm($('supabase-url-input')?.value);
  const key=norm($('supabase-key-input')?.value);
  if(!url||!key||key==='********')return notify('URL et anon key Supabase requis',true);
  supabaseUrl=url;supabaseAnonKey=key;
  localStorage.setItem('gs3_supabase_url',supabaseUrl);
  localStorage.setItem('gs3_supabase_anon_key',supabaseAnonKey);
  initSupabase();
  subscribeSupabaseRealtime();
  setTimeout(()=>saveToSupabase(false),500);
  notify('Supabase configure. Synchronisation temps reel active.');
}
async function loadFromSupabase(silent=false){
  if(!supabaseClient)return false;
  try{
    updateSyncStatus('loading');
    // Try per-table schema first
    isSupabaseNewSchema=false;
    const tableChecks=await Promise.all(TABLE_KEYS.map(async key=>{
      try{
        const {data}=await supabaseClient.from(TABLE_MAP[key]).select('id').limit(1);
        return data&&data.length>0;
      }catch(e){return false}
    }));
    const anyTableHasData=tableChecks.some(Boolean);
    if(anyTableHasData){
      isSupabaseNewSchema=true;
      const allData=await Promise.all(TABLE_KEYS.map(async key=>{
        const {data}=await supabaseClient.from(TABLE_MAP[key]).select('*');
        return data||[];
      }));
      const {data:userData}=await supabaseClient.from(USERS_TABLE).select('*');
      const remoteHasData=allData.some(arr=>arr.length>0);
      if(remoteHasData){
        // Load remote as source of truth
        isApplyingRemote=true;
        TABLE_KEYS.forEach((key,i)=>{db[key]=allData[i].map(r=>rowToObj(TABLE_MAP[key],r))});
        if(userData&&userData.length>0)users=userData.map(rowToUser);
        // Recover buyback flags from blob (for data synced before [RACHAT] convention)
        try{const{data:bs}=await supabaseClient.from('geststock_state').select('payload').eq('id',SUPABASE_STATE_ID).single();if(bs?.payload?.data?.sales){const bm=new Map();bs.payload.data.sales.filter(s=>s.isBuyback).forEach(s=>bm.set(s.id,true));db.sales.forEach(s=>{if(bm.has(s.id))s.isBuyback=true})}}catch(e){}
        save({remote:false});
        refresh();
        isApplyingRemote=false;
        isDataLoaded=true;
        updateSyncStatus();
        if(!silent)notify('Donnees chargees depuis Supabase');
      }else if(dbHasAnyData()){
        // Remote empty, push local data
        isDataLoaded=true;
        updateSyncStatus();
        await saveToSupabase(true);
      }else{
        isDataLoaded=true;
        updateSyncStatus();
      }
      return true;
    }
    // Fallback: try old blob schema
    const {data,error}=await supabaseClient.from('geststock_state').select('payload,updated_at').eq('id',SUPABASE_STATE_ID).single();
    if(!error&&data?.payload){
      const remoteHasData=payloadHasAnyData(data.payload);
      if(!remoteHasData&&dbHasAnyData()){isDataLoaded=true;updateSyncStatus();await saveToSupabase(true);return true;}
      if(data.payload.updatedAt&&data.payload.updatedAt===lastRemoteUpdatedAt){updateSyncStatus();return true;}
      if(remoteHasData&&lastLocalUpdatedAt&&data.payload.updatedAt&&lastLocalUpdatedAt>data.payload.updatedAt){updateSyncStatus();await saveToSupabase(true);return true;}
      isApplyingRemote=true;
      applyDataPayload(data.payload);
      save({remote:false});
      refresh();
      isApplyingRemote=false;
      isDataLoaded=true;
      updateSyncStatus();
      // Push migrated data to new tables
      await saveToSupabase(true);
      if(!silent)notify('Donnees importees depuis l ancien format');
    }
    else if(dbHasAnyData()){
      isDataLoaded=true;
      await saveToSupabase(true);
    }
    return true;
  }catch(e){
    isApplyingRemote=false;
    updateSyncStatus('error');
    if(!silent)notify('Lecture Supabase impossible : '+(e.message||e),true);
    return false;
  }
}
// ===== HISTORY SYSTEM =====
async function createSupabaseHistory(source='auto'){
  if(!supabaseClient||!canSyncData())return false;
  const snapshot=dataPayload();
  const {error}=await supabaseClient.from('geststock_history').insert({snapshot,source});
  if(error){
    console.warn('BACKUP SKIPPED: geststock_history unavailable',error.message||error);
    return false;
  }
  console.log('BACKUP CREATED');
  const {data:oldRows,error:oldError}=await supabaseClient.from('geststock_history').select('id').order('created_at',{ascending:false}).range(20,1000);
  if(!oldError&&oldRows?.length)await supabaseClient.from('geststock_history').delete().in('id',oldRows.map(r=>r.id));
  return true;
}
function scheduleSupabaseSave(){
  if(!isAdmin()||!supabaseClient)return;
  clearTimeout(supabaseSaveTimer);
  supabaseSaveTimer=setTimeout(()=>saveToSupabase(true),500);
}
async function saveToSupabase(silent=false){
  if(!isAdmin()||!supabaseClient)return;
  if(!canSyncData())return;
  if(supabaseSaveInProgress){pendingSupabaseSave=true;return;}
  supabaseSaveInProgress=true;
  isSavingToSupabase=true;
  try{
    updateSyncStatus('saving');
    // Per-table sync: delete stale rows + upsert current rows
    for(const key of TABLE_KEYS){
      const localRows=(db[key]||[]).map(r=>objToRow(TABLE_MAP[key],r));
      const table=TABLE_MAP[key];
      // Read current server IDs to find stale rows
      const {data:serverRows}=await supabaseClient.from(table).select('id');
      const serverIds=(serverRows||[]).map(r=>r.id);
      const localIds=localRows.map(r=>r.id);
      const toDelete=serverIds.filter(id=>!localIds.includes(id));
      if(toDelete.length>0){
        await supabaseClient.from(table).delete().in('id',toDelete);
      }
      // Batch upsert local rows (max 100 per batch)
      for(let i=0;i<localRows.length;i+=100){
        const batch=localRows.slice(i,i+100);
        const {error}=await supabaseClient.from(table).upsert(batch);
        if(error)console.warn('UPSERT ERROR',table,error);
      }
    }
    // Sync users
    const userRows=users.map(userToRow);
    const {data:serverUsers}=await supabaseClient.from(USERS_TABLE).select('id');
    const serverUserIds=(serverUsers||[]).map(r=>r.id);
    const localUserIds=userRows.map(u=>u.id);
    const usersToDelete=serverUserIds.filter(id=>!localUserIds.includes(id));
    if(usersToDelete.length>0){
      await supabaseClient.from(USERS_TABLE).delete().in('id',usersToDelete);
    }
    if(userRows.length>0){
      await supabaseClient.from(USERS_TABLE).upsert(userRows);
    }
    // Legacy blob backup
    await createSupabaseHistory('auto');
    const payload=dataPayload();
    await supabaseClient.from('geststock_state').upsert({id:SUPABASE_STATE_ID,payload,updated_at:payload.updatedAt});
    lastRemoteUpdatedAt=payload.updatedAt;
    isSupabaseNewSchema=true;
    updateSyncStatus();
    if(!silent)notify('Donnees sauvegardees dans Supabase');
  }catch(e){
    updateSyncStatus('error');
    notify('Sauvegarde Supabase impossible : '+(e.message||e),true);
  }finally{
    supabaseSaveInProgress=false;
    isSavingToSupabase=false;
    if(pendingSupabaseSave){pendingSupabaseSave=false;scheduleSupabaseSave();}
  }
}
// ===== HISTORY SYSTEM =====
async function restoreFromHistory(historyId){
  if(!requireAdmin()||!supabaseClient||!historyId)return;
  const {data,error}=await supabaseClient.from('geststock_history').select('snapshot').eq('id',historyId).single();
  if(error)throw error;
  isApplyingRemote=true;
  applyDataPayload(data.snapshot);
  lastLocalUpdatedAt=new Date().toISOString();
  localStorage.setItem('gs3_updated_at',lastLocalUpdatedAt);
  save();
  isApplyingRemote=false;
  isDataLoaded=true;
  refresh();
  await saveToSupabase(false);
  console.log('RESTORE DONE');
  notify('Restauration terminee');
}
function subscribeSupabaseRealtime(){
  if(!supabaseClient)return;
  // Remove existing channels
  if(supabaseChannel){
    if(Array.isArray(supabaseChannel))supabaseChannel.forEach(c=>supabaseClient.removeChannel(c));
    else supabaseClient.removeChannel(supabaseChannel);
  }
  const channels=[];
  // Subscribe to each entity table
  for(const[key,tableName]of Object.entries(TABLE_MAP)){
    const ch=supabaseClient
      .channel(tableName+'-realtime')
      .on('postgres_changes',{event:'*',schema:'public',table:tableName},payload=>{
        handleTableChange(key,tableName,payload);
      })
      .subscribe();
    channels.push(ch);
  }
  // Subscribe to users table
  const userCh=supabaseClient
    .channel(USERS_TABLE+'-realtime')
    .on('postgres_changes',{event:'*',schema:'public',table:USERS_TABLE},payload=>{
      if(isApplyingRemote||isSavingToSupabase||!isDataLoaded)return;
      const{eventType,new:newRow,old:oldRow}=payload;
      if(eventType==='INSERT'&&newRow){const u=rowToUser(newRow);if(!users.find(x=>x.id===u.id)){users.push(u);onRemoteChange();save({remote:false});debouncedRefresh()}}
      else if(eventType==='UPDATE'&&newRow){const u=rowToUser(newRow);const idx=users.findIndex(x=>x.id===u.id);if(idx>=0){users[idx]=u;onRemoteChange();save({remote:false});debouncedRefresh()}}
      else if(eventType==='DELETE'&&oldRow){users=users.filter(x=>x.id!==oldRow.id);onRemoteChange();save({remote:false});debouncedRefresh()}
    })
    .subscribe();
  channels.push(userCh);
  supabaseChannel=channels;
}
function onRemoteChange(){
  remoteUpdateCount++;
  const now=Date.now();
  if(now-lastRemoteNotifTime>8000){
    lastRemoteNotifTime=now;
    notify('Donnees mises a jour depuis un autre appareil');
    updateSyncStatus();
  }
}
function handleTableChange(key,tableName,payload){
  if(isApplyingRemote||isSavingToSupabase||!isDataLoaded)return;
  const{eventType,new:newRow,old:oldRow}=payload;
  if(eventType==='INSERT'&&newRow){
    const obj=rowToObj(tableName,newRow);
    if(!db[key].find(x=>x.id===obj.id)){db[key].push(obj);onRemoteChange();save({remote:false});debouncedRefresh()}
  }
  else if(eventType==='UPDATE'&&newRow){
    const obj=rowToObj(tableName,newRow);
    const idx=db[key].findIndex(x=>x.id===obj.id);
    if(idx>=0&&(!db[key][idx]._updatedAt||newRow.updated_at>=db[key][idx]._updatedAt)){db[key][idx]=obj;onRemoteChange();save({remote:false});debouncedRefresh()}
  }
  else if(eventType==='DELETE'&&oldRow){
    db[key]=db[key].filter(x=>x.id!==oldRow.id);
    onRemoteChange();
    save({remote:false});
    debouncedRefresh();
  }
}
function manualSyncToSupabase(){saveToSupabase(false)}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ EXPORT / RESTORE â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function exportBackup(){
  if(!requireAdmin())return;
  const data={...dataPayload(),exportedAt:new Date().toISOString(),app:'GestStock ERP'};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=`geststock_backup_${today()}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  notify('Sauvegarde exportee avec succes');
}
async function importBackupFile(file){
  if(!requireAdmin()||!file)return;
  try{
    const payload=normalizePayload(JSON.parse(await file.text()));
    if(!confirm('Restaurer cette sauvegarde ? Les donnees actuelles seront remplacees.'))return;
    isApplyingRemote=true;
    applyDataPayload(payload);
    lastLocalUpdatedAt=new Date().toISOString();
    localStorage.setItem('gs3_updated_at',lastLocalUpdatedAt);
    save({touch:false,remote:false});
    isApplyingRemote=false;
    isDataLoaded=true;
    refresh();
    scheduleRemoteSave();
    notify('Sauvegarde restauree avec succes');
  }catch(e){
    isApplyingRemote=false;
    notify('Sauvegarde invalide : '+(e.message||e),true);
  }
}
function openResetStockModal(){
  if(!requireAdmin())return;
  const seen=new Set();
  const movements=[...db.purchases,...db.sales.filter(x=>!x.stockIgnore),...db.transfers,...db.inventories];
  movements.forEach(x=>{if(x.key&&x.site){const k=x.key+'|'+x.site;seen.add(k)}});
  const withStock=[...seen].filter(k=>{const[key,site]=k.split('|');return stockQty(key,site)!==0});
  $('reset-current-counts').innerHTML=
    `Articles/sites avec stock : <strong>${withStock.length}</strong> ajustement(s) à créer<br>`+
    `Historique achats conservé : <strong>${db.purchases.length}</strong> écriture(s)<br>`+
    `Historique ventes conservé : <strong>${db.sales.length}</strong> écriture(s)`;
  $('restore-modal').style.display='flex';
}
// (restauration remplacee par remise a zero stock)
function applyResetStock(){
  if(!requireAdmin())return;
  if(!confirm('Creer des ajustements de remise a zero pour tous les articles sur tous les sites ?\n\nLes mouvements existants (achats, ventes, transferts) seront conserves dans l\'historique.\nDes ajustements negatifs seront crees pour ramener le stock a zero.\n\nCette action est reversible en supprimant les ajustements dans l\'historique inventaire.'))return;
  const adjustments=[];
  const seen=new Set();
  const movements=[...db.purchases,...db.sales.filter(x=>!x.stockIgnore),...db.transfers,...db.inventories];
  const refMap={};
  movements.forEach(x=>{if(x.key&&x.site){const k=x.key+'|'+x.site;seen.add(k);if(!refMap[k])refMap[k]=x}});
  seen.forEach(k=>{
    const [key,site]=k.split('|');
    const currentStock=stockQty(key,site);
    if(currentStock===0)return;
    const ref=refMap[k];
    adjustments.push({article:ref?.article||'',color:ref?.color||'',length:ref?.length||0,width:ref?.width||0,key,site,adjust:-currentStock,date:today(),note:'Remise a zero du stock',status:'OK',qty:Math.abs(currentStock)});
  });
  adjustments.forEach(a=>db.inventories.push({id:uid('inv'),...a}));
  $('restore-modal').style.display='none';
  save();
  refresh();
  notify(`OK ${adjustments.length} ajustement(s) de remise a zero crees. Historique conserve.`);
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ NOTIFY â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
let notifTimer=null;
function notify(msg,isError=false){
  const n=$('notif');
  n.textContent=msg;
  n.className='notif'+(isError?' error-notif':'');
  n.style.display='block';
  if(notifTimer)clearTimeout(notifTimer);
  notifTimer=setTimeout(()=>n.style.display='none',3500);
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ STOCK CALC â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function stockQty(key,siteId){
  let q=0;
  db.purchases.forEach(x=>{if(x.key===key&&x.site===siteId)q+=num(x.qty)});
  db.sales.forEach(x=>{if(!x.stockIgnore&&x.key===key&&x.site===siteId)q+=x.isBuyback?num(x.qty):-num(x.qty)});
  db.transfers.forEach(x=>{if(x.key===key&&x.from===siteId)q-=num(x.qty);if(x.key===key&&x.to===siteId)q+=num(x.qty)});
  db.inventories.forEach(x=>{if(x.key===key&&x.site===siteId)q+=num(x.adjust)});
  return q;
}
function stockRows(){const map={};[...db.purchases,...db.sales.filter(x=>!x.stockIgnore),...db.transfers,...db.inventories].forEach(x=>{if(!x.key)return;map[x.key]={article:x.article,color:x.color,length:num(x.length),width:num(x.width),key:x.key}});return Object.values(map)}
function globalQty(key){return db.sites.reduce((s,site)=>s+stockQty(key,site.id),0)}
function stockValue(article,qty,l,w){const base=db.supplierPrices.find(p=>p.article===article)||db.clientPrices.find(p=>p.article===article);return base?surface(l,w,qty)*num(base.pm2):0}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ ENTITY PRICE â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function entityPrice(type,entity,article){
  const arr=type==='client'?db.clientPrices:db.supplierPrices;
  const key=type==='client'?'client':'supplier';
  const row=arr.find(x=>x[key]===entity&&x.article===article);
  if(row)return num(row.pm2);
  if(type==='client'){const art=db.articles.find(x=>x.name===article);return num(art?.defaultPm2||0)}
  return 0;
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ ACCOUNT â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
// ===== PAYMENT STATUS =====
function normalizedPaymentStatus(p){
  if(p.paidStatus==='paid'||p.paidStatus==='unpaid')return p.paidStatus;
  if(p.due){
    const d=new Date(p.due),t=new Date(today());d.setHours(0,0,0,0);t.setHours(0,0,0,0);
    if(d<t)return'unpaid';
    if(p.deductNow===false)return'pending';
  }
  return p.deductNow===false?'pending':'paid';
}
function normalizePayments(){
  db.payments=(db.payments||[]).map(p=>({...p,paidStatus:normalizedPaymentStatus(p)}));
}
function isPaymentDeductible(p){return normalizedPaymentStatus(p)==='paid'}
// ===== CLIENT FEES + AUDIT =====
function isFeeSale(x){return x?.isFee||x?.horsStock&&['Transport','Frais transport','Frais couture','Surgi moquette','Couture','Surgi'].includes(x.article)}
function operationKind(x){return x.isBuyback?'Rachat':isFeeSale(x)?(x.feeType||x.article||'Frais'):'Marchandise'}
function saveAuditLog(){
  try{localStorage.setItem('gs3_operation_audit',JSON.stringify(operationAuditLog.slice(-80)))}catch(e){}
}
function auditOperation(action,type,before,after){
  operationAuditLog.push({
    id:uid('aud'),date:new Date().toISOString(),user:currentUser?.name||'system',
    action,type,entity:(after||before)?.client||(after||before)?.supplier||(after||before)?.name||'',
    before:before?JSON.parse(JSON.stringify(before)):null,
    after:after?JSON.parse(JSON.stringify(after)):null
  });
  operationAuditLog=operationAuditLog.slice(-80);
  saveAuditLog();
}
function createClientFee(client,type,amount,date,note){
  const feeType=type||'Frais';
  const total=num(amount);
  if(!client||total<=0)return false;
  db.sales.push({
    id:uid('sale'),client,article:feeType,color:'Service',site:'',length:100,width:100,qty:1,pm2:total,
    date:date||today(),note:note||feeType,key:keyOf(feeType,'Service',100,100),total,
    stockIgnore:true,horsStock:true,isFee:true,feeType
  });
  auditOperation('create_fee','sale',null,db.sales[db.sales.length-1]);
  save();refresh();notify('Frais client ajoute');
  return true;
}
function promptClientFee(clientName){
  if(!requireAdmin())return;
  const client=clientName||$('s-client')?.value||view.clientAccount;
  if(!client)return alert('Choisissez un client.');
  const type=prompt('Type de frais (Transport, Couture, Surgi, Emballage)', 'Transport');
  if(type===null)return;
  const amount=num(prompt('Montant des frais', '0'));
  if(amount<=0)return alert('Montant invalide');
  const date=prompt('Date', today());
  if(date===null)return;
  const note=prompt('Remarque', type)||type;
  createClientFee(client,type,amount,date,note);
}
function enhanceFeeAndAuditUI(){
  const saleToolbar=$('mv-sale')?.querySelector('.toolbar');
  if(saleToolbar&&!$('btn-sale-client-fee'))saleToolbar.insertAdjacentHTML('beforeend','<button class="btn ok" id="btn-sale-client-fee" onclick="promptClientFee()">Ajouter frais client</button>');
  const clientPanel=$('acc-client');
  if(clientPanel){
    const toolbar=clientPanel.querySelector('.toolbar');
    if(toolbar&&!$('btn-account-client-fee'))toolbar.insertAdjacentHTML('afterbegin',`<button class="btn ok" id="btn-account-client-fee" onclick="promptClientFee('${view.clientAccount||''}')">Créer frais client</button>`);
    const sum=accountSummary('client',view.clientAccount);
    const feeTotal=sum.ops.filter(isFeeSale).reduce((s,x)=>s+num(x.total),0);
    const summary=clientPanel.querySelector('.summary');
    if(summary&&!$('client-fee-total-box'))summary.insertAdjacentHTML('beforeend',`<div class="box" id="client-fee-total-box"><div class="k">Dont frais</div><div class="v">${dh(feeTotal)}</div></div>`);
    const opTable=clientPanel.querySelectorAll('table')[0];
    if(opTable&&!opTable.dataset.feeTypeColumn){
      opTable.dataset.feeTypeColumn='1';
      opTable.querySelector('thead tr')?.children[1]?.insertAdjacentHTML('afterend','<th>Type</th>');
      opTable.querySelectorAll('tbody tr').forEach((tr,i)=>{
        if(tr.querySelector('.empty')){tr.querySelector('.empty').colSpan=(parseInt(tr.querySelector('.empty').colSpan)||10)+1;return;}
        const row=sum.ops[i];
        tr.children[1]?.insertAdjacentHTML('afterend',`<td><span class="badge ${row.isBuyback?'b-bad':isFeeSale(row)?'b-warn':'b-ok'}">${operationKind(row)}</span></td>`);
      });
    }
    const auditRows=operationAuditLog.filter(x=>!view.clientAccount||x.entity===view.clientAccount).slice(-12).reverse().map((x,i)=>`<tr><td>${i+1}</td><td>${x.date.slice(0,16).replace('T',' ')}</td><td>${x.user}</td><td>${x.action}</td><td>${x.type}</td></tr>`).join('');
    if(!$('client-audit-table'))clientPanel.insertAdjacentHTML('beforeend',`<div class="section-title">Historique modifications</div><div class="table-wrap"><table class="table" id="client-audit-table"><thead><tr><th>#</th><th>Date</th><th>Utilisateur</th><th>Action</th><th>Type</th></tr></thead><tbody>${auditRows||'<tr><td class="empty" colspan="5">Aucun historique</td></tr>'}</tbody></table></div>`);
  }
}
function accountSummary(type,name){
  const entity=(type==='client'?db.clients:db.suppliers).find(x=>x.name===name);
  const init=num(entity?.initial||0);
  const ops=(type==='client'?db.sales:db.purchases).filter(x=>(type==='client'?x.client:x.supplier)===name);
  const totalSales=ops.reduce((s,x)=>x.isBuyback?s:s+num(x.total),0);
  const totalBuybacks=ops.reduce((s,x)=>x.isBuyback?s+num(x.total):s,0);
  const totalOps=totalSales-totalBuybacks;
  const payments=db.payments.filter(x=>x.type===type&&x.name===name);
  // Only deduct payments that are deductNow=true, OR have no due date, OR due date has passed
  const today_=new Date();today_.setHours(0,0,0,0);
  const totalPay=payments.reduce((s,x)=>{
    if(x.paidStatus)return isPaymentDeductible(x)?s+num(x.amount):s;
    if(x.deductNow===false){
      // wait-for-due mode: deduct only if due date has passed AND marked paid
      if(x.paidStatus==='paid')return s+num(x.amount);
      return s; // not yet deducted
    }
    // default: always deduct (deductNow=true or legacy payments without flag)
    return s+num(x.amount);
  },0);
  return{entity,init,totalSales,totalBuybacks,totalOps,totalPay,balance:init+totalOps-totalPay,ops,payments};
}
function dueState(d){if(!d)return{label:'-',cls:'b-brand'};const t=new Date(today()),x=new Date(d);t.setHours(0,0,0,0);x.setHours(0,0,0,0);const days=Math.round((x-t)/86400000);if(days<0)return{label:`Depassee (${Math.abs(days)}j)`,cls:'b-bad'};if(days===0)return{label:"Aujourd'hui",cls:'b-warn'};return{label:`${days}j`,cls:days<=7?'b-warn':'b-ok'}}
function paymentStatus(p){
  const status=normalizedPaymentStatus(p);
  if(status==='paid')return'Paid';
  if(status==='unpaid')return'Unpaid';
  if(status==='pending')return'Pending';
  if(p.deductNow===false){
    if(p.paidStatus==='paid')return'Paye';
    if(p.paidStatus==='unpaid')return'Impaye';
    const s=dueState(p.due);
    if(s.label.includes('Depassee'))return'Impaye';
    if(s.label==="Aujourd'hui")return'DÃƒ aujourd\'hui';
    return'En attente echeance';
  }
  if(!p.due)return'Confirme';
  const s=dueState(p.due);
  return s.label.includes('Dépassée')?'Impayé':s.label==="Aujourd'hui"?'Dû':'En cours';
}
function siteName(id){return db.sites.find(s=>s.id===id)?.name||'-'}
function opt(list,placeholder,key='name',label='name'){return`<option value="">${h(placeholder)}</option>`+list.map(x=>`<option value="${attr(x[key])}">${h(x[label])}</option>`).join('')}
function articleByName(name){return db.articles.find(a=>a.name===name)}
function articleType(name){return articleByName(name)?.type||'tapis'}
function isMoquetteArticle(name){return articleType(name)==='moquette'}
function pendingRollUsage(rollId){return sessionLines.sale.filter(x=>x.rollId===rollId).reduce((s,x)=>s+num(x.length),0)}
function getRollById(id){return db.rolls.find(r=>r.id===id)}
function getAvailableRolls(article,color,site){
  return db.rolls
    .filter(r=>r.article===article&&(!color||r.color===color)&&(!site||r.site===site)&&num(r.currentLength)>0)
    .map(r=>({...r,availableLength:Math.max(0,num(r.currentLength)-pendingRollUsage(r.id))}))
    .filter(r=>r.availableLength>0)
    .sort((a,b)=>num(b.availableLength)-num(a.availableLength));
}
function rollLabel(roll){return `${roll.code||roll.id} - ${roll.availableLength||roll.currentLength} cm x ${roll.width} - ${siteName(roll.site)}`}
function rollHistoryNote(r){return r.rollCode?`Rouleau ${r.rollCode}`:'-'}
function recalcRollState(rollId){
  const roll=getRollById(rollId);
  if(!roll)return;
  const cuts=db.rollCuts.filter(c=>c.rollId===rollId).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const sold=cuts.reduce((s,c)=>s+num(c.soldLength),0);
  roll.currentLength=Math.max(0,num(roll.originalLength)-sold);
  roll.status=roll.currentLength<=0?'sold':sold>0?'partial':'full';
}
function removeMoquetteEffects(sale){
  if(!sale?.moquetteSale)return;
  const saleId=sale.id;
  db.inventories=db.inventories.filter(inv=>{
    if(inv.sourceSaleId===saleId)return false;
    if(inv.sourceSaleId)return true;
    const sameRollNote=(inv.note||'').includes(sale.rollCode||sale.rollId||'');
    return !(sameRollNote&&inv.date===sale.date&&inv.article===sale.article&&inv.site===sale.site&&num(inv.width)===num(sale.width));
  });
  db.rollCuts=db.rollCuts.filter(cut=>{
    if(cut.sourceSaleId===saleId)return false;
    if(cut.sourceSaleId)return true;
    return !(cut.rollId===sale.rollId&&cut.date===sale.date&&cut.client===sale.client&&num(cut.soldLength)===num(sale.length));
  });
  if(sale.rollId)recalcRollState(sale.rollId);
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ PERIOD HELPERS â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function dateInPeriod(dateStr,periodDays){
  if(!periodDays)return true;
  const d=new Date(dateStr);const now=new Date();
  return(now-d)/(86400000)<=periodDays;
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ RENDER DATABASE â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function renderMaster(panel,title,desc,fields,rows,extra=''){
  $(panel).innerHTML=`
    <div class="panel-head"><div><h2>${title}</h2><p>${desc}</p></div></div>
    ${fields}
    <div class="table-wrap"><table class="table">
      <thead><tr>${rows.head.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.body.length?rows.body.join(''):`<tr><td class="empty" colspan="${rows.head.length}">Aucune donnée</td></tr>`}</tbody>
    </table></div>
    ${extra}`;
}
function renderDatabase(){
  renderMaster('db-articles','Articles','Referentiel articles avec prix client par defaut.',
    `<div class="form-grid"><div class="field"><label>Nom article</label><input id="f-article-name" placeholder="Ex: Marbre Blanc"></div><div class="field"><label>Prix defaut m2</label><input id="f-article-default" type="number" step="0.01" min="0" placeholder="0.00"></div></div><div class="toolbar"><button class="btn primary" onclick="saveArticle()">Enregistrer</button><button class="btn" onclick="clearForm('article')">Annuler</button></div>`,
    {head:['#','Nom','Prix defaut','Action'],body:db.articles.map((a,i)=>`<tr class="${edit.article===i?'row-editing':''}"><td>${i+1}</td><td>${h(a.name)}</td><td>${dh(a.defaultPm2||0)}</td><td style="white-space:nowrap"><button class="btn sm alt" onclick="editArticle(${i})">Modifier</button> <button class="btn sm danger" onclick="removeRow('articles',${i})">X</button></td></tr>`)});
  if($('f-article-default')&&!$('f-article-type')){
    const field=$('f-article-default').closest('.field');
    if(field){
      field.insertAdjacentHTML('beforebegin',`<div class="field"><label>Type</label><select id="f-article-type"><option value="tapis">Tapis</option><option value="moquette">Moquette</option></select></div>`);
    }
    const table=$('db-articles')?.querySelector('table');
    table?.querySelector('thead tr')?.children[1]?.insertAdjacentHTML('afterend','<th>Type</th>');
    table?.querySelectorAll('tbody tr').forEach((tr,i)=>{
      if(tr.querySelector('.empty'))return;
      const a=db.articles[i]||{};
      tr.children[1]?.insertAdjacentHTML('afterend',`<td><span class="badge ${a.type==='moquette'?'b-purple':'b-brand'}">${a.type==='moquette'?'Moquette':'Tapis'}</span></td>`);
    });
  }
  if(edit.article>=0){$('f-article-name').value=db.articles[edit.article].name;$('f-article-type').value=db.articles[edit.article].type||'tapis';$('f-article-default').value=num(db.articles[edit.article].defaultPm2||0)}

  renderMaster('db-clients','Clients','Base clients avec ville et solde initial.',
    `<div class="form-grid"><div class="field"><label>Nom</label><input id="f-client-name" placeholder="Nom client"></div><div class="field"><label>Ville</label><input id="f-client-city" placeholder="Ville"></div><div class="field"><label>Solde initial</label><input id="f-client-initial" type="number" step="0.01" placeholder="0.00"></div></div><div class="toolbar"><button class="btn primary" onclick="saveClient()">Enregistrer</button><button class="btn" onclick="clearForm('client')">Annuler</button></div>`,
    {head:['#','Nom','Ville','Solde initial','Action'],body:db.clients.map((c,i)=>`<tr class="${edit.client===i?'row-editing':''}"><td>${i+1}</td><td>${h(c.name)}</td><td>${h(c.city)}</td><td>${dh(c.initial||0)}</td><td style="white-space:nowrap"><button class="btn sm alt" onclick="editClientRow(${i})">Modifier</button> <button class="btn sm danger" onclick="removeRow('clients',${i})">X</button></td></tr>`)});
  if(edit.client>=0){const r=db.clients[edit.client];$('f-client-name').value=r.name;$('f-client-city').value=r.city;$('f-client-initial').value=r.initial||0}

  renderMaster('db-suppliers','Fournisseurs','Base fournisseurs avec ville et solde initial.',
    `<div class="form-grid"><div class="field"><label>Nom</label><input id="f-supplier-name" placeholder="Nom fournisseur"></div><div class="field"><label>Ville</label><input id="f-supplier-city" placeholder="Ville"></div><div class="field"><label>Solde initial</label><input id="f-supplier-initial" type="number" step="0.01" placeholder="0.00"></div></div><div class="toolbar"><button class="btn primary" onclick="saveSupplier()">Enregistrer</button><button class="btn" onclick="clearForm('supplier')">Annuler</button></div>`,
    {head:['#','Nom','Ville','Solde initial','Action'],body:db.suppliers.map((c,i)=>`<tr class="${edit.supplier===i?'row-editing':''}"><td>${i+1}</td><td>${h(c.name)}</td><td>${h(c.city)}</td><td>${dh(c.initial||0)}</td><td style="white-space:nowrap"><button class="btn sm alt" onclick="editSupplierRow(${i})">Modifier</button> <button class="btn sm danger" onclick="removeRow('suppliers',${i})">X</button></td></tr>`)});
  if(edit.supplier>=0){const r=db.suppliers[edit.supplier];$('f-supplier-name').value=r.name;$('f-supplier-city').value=r.city;$('f-supplier-initial').value=r.initial||0}

  renderMaster('db-client-prices','Prix client','Prix m2 automatique pour les ventes.',
    `<div class="form-grid"><div class="field"><label>Client</label><select id="f-cp-client">${opt(db.clients,'Choisir client')}</select></div><div class="field"><label>Article</label><select id="f-cp-article">${opt(db.articles,'Choisir article')}</select></div><div class="field"><label>Prix m2</label><input id="f-cp-pm2" type="number" step="0.01" min="0" placeholder="0.00"></div></div><div class="toolbar"><button class="btn primary" onclick="saveClientPrice()">Enregistrer</button><button class="btn" onclick="clearForm('cp')">Annuler</button></div>`,
    {head:['#','Client','Article','Prix m2','Action'],body:db.clientPrices.map((r,i)=>`<tr class="${edit.cp===i?'row-editing':''}"><td>${i+1}</td><td>${h(r.client)}</td><td>${h(r.article)}</td><td>${dh(r.pm2)}</td><td style="white-space:nowrap"><button class="btn sm alt" onclick="editClientPrice(${i})">Modifier</button> <button class="btn sm danger" onclick="removeRow('clientPrices',${i})">X</button></td></tr>`)});
  if(edit.cp>=0){const r=db.clientPrices[edit.cp];$('f-cp-client').value=r.client;$('f-cp-article').value=r.article;$('f-cp-pm2').value=r.pm2}

  renderMaster('db-supplier-prices','Prix fournisseur','Prix m2 automatique pour les achats.',
    `<div class="form-grid"><div class="field"><label>Fournisseur</label><select id="f-sp-supplier">${opt(db.suppliers,'Choisir fournisseur')}</select></div><div class="field"><label>Article</label><select id="f-sp-article">${opt(db.articles,'Choisir article')}</select></div><div class="field"><label>Prix m2</label><input id="f-sp-pm2" type="number" step="0.01" min="0" placeholder="0.00"></div></div><div class="toolbar"><button class="btn primary" onclick="saveSupplierPrice()">Enregistrer</button><button class="btn" onclick="clearForm('sp')">Annuler</button></div>`,
    {head:['#','Fournisseur','Article','Prix m2','Action'],body:db.supplierPrices.map((r,i)=>`<tr class="${edit.sp===i?'row-editing':''}"><td>${i+1}</td><td>${h(r.supplier)}</td><td>${h(r.article)}</td><td>${dh(r.pm2)}</td><td style="white-space:nowrap"><button class="btn sm alt" onclick="editSupplierPrice(${i})">Modifier</button> <button class="btn sm danger" onclick="removeRow('supplierPrices',${i})">X</button></td></tr>`)});
  if(edit.sp>=0){const r=db.supplierPrices[edit.sp];$('f-sp-supplier').value=r.supplier;$('f-sp-article').value=r.article;$('f-sp-pm2').value=r.pm2}

  renderMaster('db-sites','Sites / Entrepots','Points de vente et entrepots separes.',
    `<div class="form-grid"><div class="field"><label>Nom site</label><input id="f-site-name" placeholder="Ex: Magasin Central"></div><div class="field"><label>Ville</label><input id="f-site-city" placeholder="Ville"></div></div><div class="toolbar"><button class="btn primary" onclick="saveSite()">Enregistrer</button><button class="btn" onclick="clearForm('site')">Annuler</button></div>`,
    {head:['#','Nom','Ville','Action'],body:db.sites.map((s,i)=>`<tr class="${edit.site===i?'row-editing':''}"><td>${i+1}</td><td>${h(s.name)}</td><td>${h(s.city)}</td><td style="white-space:nowrap"><button class="btn sm alt" onclick="editSiteRow(${i})">Modifier</button> <button class="btn sm danger" onclick="removeSite(${i})">X</button></td></tr>`)});
  if(edit.site>=0){const s=db.sites[edit.site];$('f-site-name').value=s.name;$('f-site-city').value=s.city}
  renderUsersPanel();
}

function renderUsersPanel(){
  $('db-users').innerHTML=`
    <div class="panel-head"><div><h2>Utilisateurs</h2><p>Gestion des comptes synchronises avec la base GitHub.</p></div></div>
    <div class="quick-entry">
      <h4>Synchronisation Supabase temps reel</h4>
      <div class="form-grid">
        <div class="field"><label>Supabase URL</label><input id="supabase-url-input" type="url" placeholder="https://xxxx.supabase.co"></div>
        <div class="field"><label>Supabase anon key</label><input id="supabase-key-input" type="password" placeholder="Anon public key"></div>
      </div>
      <div class="toolbar">
        <button class="btn primary" onclick="saveSupabaseConfig()">Activer Supabase</button>
        <button class="btn ok" onclick="manualSyncToSupabase()">Forcer sauvegarde Supabase</button>
        <button class="btn alt" onclick="loadFromSupabase()">Recharger Supabase</button>
      </div>
      <p style="font-size:12px;color:var(--mut)">Mode recommande : donnees dans Supabase, synchronisation temps reel PC/telephone, sans token GitHub. Pour un usage professionnel, appliquez les policies Supabase du dossier docs et evitez les mots de passe par defaut.</p>
    </div>
    <div class="quick-entry">
      <h4>Sauvegarde locale</h4>
      <div class="toolbar">
        <button class="btn alt" onclick="exportBackup()">Exporter sauvegarde JSON</button>
        <label class="btn warn" for="backup-import-input">Restaurer sauvegarde JSON</label>
        <input id="backup-import-input" type="file" accept="application/json,.json" style="display:none">
      </div>
      <p style="font-size:12px;color:var(--mut)">La restauration valide le format avant remplacement et relance ensuite la synchronisation distante.</p>
    </div>
    <div class="quick-entry">
      <h4>Ajouter / modifier utilisateur</h4>
      <div class="form-grid">
        <div class="field"><label>Nom</label><input id="f-user-name" placeholder="Nom utilisateur"></div>
        <div class="field"><label>Role</label><select id="f-user-role"><option value="visitor">Visiteur</option><option value="admin">Admin</option></select></div>
        <div class="field"><label>Mot de passe</label><input id="f-user-password" type="password" placeholder="Nouveau mot de passe"></div>
      </div>
      <div class="toolbar"><button class="btn primary" onclick="saveUser()">Enregistrer utilisateur</button></div>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Nom</th><th>Role</th><th>Action</th></tr></thead>
      <tbody>${users.length?users.map((u,i)=>`<tr><td>${i+1}</td><td>${h(u.name)}</td><td><span class="badge ${u.role==='admin'?'b-purple':'b-brand'}">${u.role==='admin'?'Admin':'Visiteur'}</span></td><td><button class="btn sm danger" onclick="deleteUser('${attr(u.id)}')">Supprimer</button></td></tr>`).join(''):`<tr><td class="empty" colspan="4">Aucun utilisateur</td></tr>`}</tbody>
    </table></div>`;
  if($('supabase-url-input'))$('supabase-url-input').value=supabaseUrl;
  if($('supabase-key-input'))$('supabase-key-input').value=supabaseAnonKey?'********':'';
  $('backup-import-input')?.addEventListener('change',e=>{importBackupFile(e.target.files?.[0]);e.target.value='';},{once:true});
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ RENDER MOVEMENTS â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function renderMovements(){
  // PURCHASE - achat fournisseur (pas inventaire)
  $('mv-purchase').innerHTML=`
    <div class="panel-head"><div><h2>â¬â€¡ Achat fournisseur</h2><p>Entrez les achats depuis vos fournisseurs. L'import Excel pour le stock est dans "Import Stock".</p></div></div>
    <div class="quick-entry">
      <h4>âš¡ Saisie rapide</h4>
      <div class="form-grid tight">
        <div class="field"><label>Date</label><input id="p-date" type="date"></div>
        <div class="field"><label>Fournisseur</label><select id="p-supplier">${opt(db.suppliers,'Fournisseur')}</select></div>
        <div class="field"><label>Article</label><select id="p-article">${opt(db.articles,'Article')}</select></div>
        <div class="field"><label>Site IN</label><select id="p-site">${opt(db.sites,'Site','id','name')}</select></div>
        <div class="field"><label>Couleur</label><input id="p-color" placeholder="Couleur" list="p-color-list"><datalist id="p-color-list">${[...new Set(db.purchases.map(x=>x.color))].filter(Boolean).map(c=>`<option value="${attr(c)}">`).join('')}</datalist></div>
        <div class="field"><label>Longueur (cm)</label><input id="p-length" type="number" step="0.01" placeholder="0.00"></div>
        <div class="field"><label>Largeur (cm)</label><input id="p-width" type="number" step="0.01" placeholder="0.00"></div>
        <div class="field"><label>Quantite</label><input id="p-qty" type="number" step="1" placeholder="0"></div>
        <div class="field"><label>Prix m2</label><input id="p-pm2" type="number" step="0.01" placeholder="0.00"></div>
        <div class="field"><label>Remarque</label><input id="p-note" placeholder="Optionnel"></div>
      </div>
    </div>
    <div class="summary">
      <div class="box"><div class="k">Surface</div><div class="v" id="p-surface">0.00 m2</div></div>
      <div class="box"><div class="k">Total</div><div class="v" id="p-total">0.00 DH</div></div>
    </div>
    <div class="toolbar">
      <button class="btn primary" onclick="savePurchase()">+ Ajouter ligne</button>
      <button class="btn" onclick="clearFormMv('purchase')">Annuler</button>
    </div>
    ${renderSessionTable('purchase',['#','Date','Fournisseur','Article','Couleur','Long.','Larg.','Qte','Prix m2','Total',''],
      sessionLines.purchase.map((r,i)=>`<tr>
        <td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.supplier)}</td><td>${h(r.article)}</td>
        <td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.qty)}</td>
        <td>${dh(r.pm2)}</td><td>${dh(r.total)}</td>
        <td><button class="btn sm danger" onclick="removeSessionLine('purchase',${i})">âÅ“â€¢</button>
            <button class="btn sm alt" onclick="openEditLine('purchase',${i})">âÅ“</button></td>
      </tr>`),'purchase')}`;

  // SALE - vente client
  $('mv-sale').innerHTML=`
    <div class="panel-head"><div><h2>Vente Opération de vente</h2><p>Enregistrez les ventes. Le stock est deduit automatiquement.</p></div></div>
    <div class="quick-entry">
      <h4>âš¡ Saisie rapide</h4>
      <div class="form-grid tight">
        <div class="field"><label>Date</label><input id="s-date" type="date"></div>
        <div class="field"><label>Client</label><select id="s-client">${opt(db.clients,'Client')}</select></div>
        <div class="field" id="s-article-field"><label>Article</label><select id="s-article" onchange="onSaleArticleChange()">${opt(db.articles,'Article')}</select></div>
        <div class="field" id="s-site-field"><label>Site OUT</label><select id="s-site">${opt(db.sites,'Site','id','name')}</select></div>
        <div class="field" id="s-color-field"><label>Couleur</label><select id="s-color"><option value="">-- Selectionner couleur --</option></select></div>
        <div class="field" id="s-dim-field"><label>Dimensions (L x l)</label><select id="s-dim"><option value="">-- Selectionner dim. --</option></select></div>
        <div class="field"><label>Longueur (cm)</label><input id="s-length" type="number" step="0.01" placeholder="0.00" readonly style="background:#f0f4f9"></div>
        <div class="field"><label>Largeur (cm)</label><input id="s-width" type="number" step="0.01" placeholder="0.00" readonly style="background:#f0f4f9"></div>
        <div class="field"><label>Quantite</label><input id="s-qty" type="number" step="1" placeholder="0"></div>
        <div class="field"><label>Prix m2</label><input id="s-pm2" type="number" step="0.01" placeholder="0.00"></div>
        <div class="field"><label>Remarque</label><input id="s-note" placeholder="Optionnel"></div>
      </div>
    </div>
    <div class="summary">
      <div class="box"><div class="k">Surface</div><div class="v" id="s-surface">0.00 m2</div></div>
      <div class="box"><div class="k">Total</div><div class="v" id="s-total-box">0.00 DH</div></div>
      <div class="box" id="s-stock-dispo-box"><div class="k">Stock dispo (site)</div><div class="v" id="s-stock-dispo" style="color:var(--ok)">-</div></div>
    </div>
    <div class="toolbar">
      <button class="btn primary" onclick="saveSale()">+ Ajouter ligne</button>
      <button class="btn" onclick="clearFormMv('sale')">Annuler</button>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-left:8px;padding:8px 12px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;font-size:13px;font-weight:600;color:#9a3412">
        <input type="checkbox" id="s-hors-stock" style="width:16px;height:16px;cursor:pointer;accent-color:#dc2626" onchange="onHorsStockChange()">
        Attention Article hors stock (operation libre)
      </label>
    </div>
    ${renderSessionTable('sale',['#','Date','Client','Article','Couleur','Long.','Larg.','Qte','Prix m2','Total','Statut',''],
      sessionLines.sale.map((r,i)=>`<tr>
        <td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.client)}</td><td>${h(r.article)}</td>
        <td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.qty)}</td>
        <td>${dh(r.pm2)}</td><td>${dh(r.total)}</td>
        <td>${r.isFee?'<span class="badge b-warn">Frais</span>':r.horsStock?'<span class="badge b-warn">&#9888; Hors stock</span>':r.moquetteSale?'<span class="badge b-purple">Moquette</span>':'<span class="badge b-ok">Normal</span>'}</td>
        <td><button class="btn sm danger" onclick="removeSessionLine('sale',${i})">&#x2715;</button>
            <button class="btn sm alt" onclick="openEditLine('sale',${i})">&#x270f;</button></td>
      </tr>`),'sale')}`;

  // BUYBACK - rachat client
  $('mv-buyback').innerHTML=`
    <div class="panel-head"><div><h2>Rachat Rachat client</h2><p>Achetez de la marchandise aupres d un client. Le stock augmente et une ecriture creditrice est ajoutee au compte client.</p></div></div>
    <div class="quick-entry">
      <h4>Saisie rapide</h4>
      <div class="form-grid tight">
        <div class="field"><label>Date</label><input id="b-date" type="date"></div>
        <div class="field"><label>Client</label><select id="b-client">${opt(db.clients,'Client')}</select></div>
        <div class="field"><label>Article</label><select id="b-article">${opt(db.articles,'Article')}</select></div>
        <div class="field"><label>Site IN</label><select id="b-site">${opt(db.sites,'Site','id','name')}</select></div>
        <div class="field"><label>Couleur</label><input id="b-color" placeholder="Couleur" list="b-color-list"><datalist id="b-color-list">${[...new Set(db.sales.map(x=>x.color))].filter(Boolean).map(c=>'<option value="'+attr(c)+'">').join('')}</datalist></div>
        <div class="field"><label>Longueur (cm)</label><input id="b-length" type="number" step="0.01" placeholder="0.00"></div>
        <div class="field"><label>Largeur (cm)</label><input id="b-width" type="number" step="0.01" placeholder="0.00"></div>
        <div class="field"><label>Quantite</label><input id="b-qty" type="number" step="1" placeholder="0"></div>
        <div class="field"><label>Prix m2</label><input id="b-pm2" type="number" step="0.01" placeholder="0.00"></div>
        <div class="field"><label>Remarque</label><input id="b-note" placeholder="Optionnel"></div>
      </div>
    </div>
    <div class="summary">
      <div class="box"><div class="k">Surface</div><div class="v" id="b-surface">0.00 m2</div></div>
      <div class="box"><div class="k">Total</div><div class="v" id="b-total">0.00 DH</div></div>
    </div>
    <div class="toolbar">
      <button class="btn primary" onclick="saveBuyback()">+ Ajouter ligne</button>
      <button class="btn" onclick="clearFormMv('buyback')">Annuler</button>
    </div>
    ${renderSessionTable('buyback',['#','Date','Client','Article','Couleur','Long.','Larg.','Qte','Prix m2','Total',''],
      sessionLines.buyback.map((r,i)=>`<tr>
        <td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.client)}</td><td>${h(r.article)}</td>
        <td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.qty)}</td>
        <td>${dh(r.pm2)}</td><td>${dh(r.total)}</td>
        <td><button class="btn sm danger" onclick="removeSessionLine('buyback',${i})">X</button>
            <button class="btn sm alt" onclick="openEditLine('buyback',${i})">Edit</button></td>
      </tr>`),'rachat')}`;
  // TRANSFER
  $('mv-transfer').innerHTML=`
    <div class="panel-head"><div><h2>ââ€ " Transfert intersite</h2><p>Deplacez du stock entre sites.</p></div></div>
    <div class="form-grid">
      <div class="field"><label>Date</label><input id="t-date" type="date"></div>
      <div class="field"><label>Article</label><select id="t-article">${opt(db.articles,'Choisir article')}</select></div>
      <div class="field"><label>Site OUT</label><select id="t-from">${opt(db.sites,'Choisir site','id','name')}</select></div>
      <div class="field"><label>Site IN</label><select id="t-to">${opt(db.sites,'Choisir site','id','name')}</select></div>
      <div class="field"><label>Couleur</label><input id="t-color" placeholder="Couleur"></div>
      <div class="field"><label>Longueur</label><input id="t-length" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>Largeur</label><input id="t-width" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>Quantite</label><input id="t-qty" type="number" step="1" placeholder="0"></div>
      <div class="field full-col"><label>Remarque</label><input id="t-note" placeholder="Optionnel"></div>
    </div>
    <div class="summary"><div class="box"><div class="k">Surface</div><div class="v" id="t-surface">0.00 m2</div></div></div>
    <div class="toolbar">
      <button class="btn primary" onclick="saveTransfer()">+ Ajouter transfert</button>
      <button class="btn" onclick="clearFormMv('transfer')">Annuler</button>
    </div>
    ${renderSessionTable('transfer',['#','Date','Article','Couleur','Long.','Larg.','Qte','Site OUT','Site IN',''],
      sessionLines.transfer.map((r,i)=>`<tr>
        <td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.article)}</td>
        <td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.qty)}</td>
        <td>${siteName(r.from)}</td><td>${siteName(r.to)}</td>
        <td><button class="btn sm danger" onclick="removeSessionLine('transfer',${i})">âÅ“â€¢</button></td>
      </tr>`),'transfer')}`;

  // HISTORY
  const hist=[
    ...db.purchases.map(x=>({date:x.date,type:'Achat',article:x.article,color:x.color,length:x.length,width:x.width,site:siteName(x.site),partner:x.supplier,qty:x.qty,total:x.total,note:x.note||'-'})),
    ...db.sales.filter(x=>!x.isBuyback).map(x=>({date:x.date,type:'Vente',article:x.article,color:x.color,length:x.length,width:x.width,site:siteName(x.site),partner:x.client,qty:x.qty,total:x.total,note:x.note||'-'})),
    ...db.sales.filter(x=>x.isBuyback).map(x=>({date:x.date,type:'Rachat',article:x.article,color:x.color,length:x.length,width:x.width,site:siteName(x.site),partner:x.client,qty:x.qty,total:x.total,note:x.note||'-'})),
    ...db.transfers.map(x=>({date:x.date,type:'Transfert',article:x.article,color:x.color,length:x.length,width:x.width,site:`${siteName(x.from)} -> ${siteName(x.to)}`,partner:'-',qty:x.qty,total:0,note:x.note||'-'})),
  ].sort((a,b)=>b.date.localeCompare(a.date));

  $('mv-history').innerHTML=`
    <div class="panel-head"><div><h2>Historique mouvements</h2><p>Tous les achats, ventes et transferts.</p></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Date</th><th>Type</th><th>Article</th><th>Couleur</th><th>Dimensions</th><th>Site</th><th>Partenaire</th><th>Qte</th><th>Total</th><th>Note</th></tr></thead>
      <tbody>${hist.length?hist.map((r,i)=>`<tr><td>${i+1}</td><td>${h(r.date)}</td>
        <td><span class="badge ${r.type==='Achat'?'b-brand':r.type==='Vente'?'b-ok':r.type==='Rachat'?'b-warn':'b-purple'}">${r.type}</span></td>
        <td>${h(r.article)}</td><td>${h(r.color||'-')}</td><td>${r.length&&r.width?h(r.length+' x '+r.width):'-'}</td>
        <td>${h(r.site)}</td><td>${h(r.partner)}</td><td>${h(r.qty)}</td><td>${r.total?dh(r.total):'-'}</td><td>${h(r.note)}</td></tr>`).join(''):`<tr><td class="empty" colspan="11">Aucun mouvement</td></tr>`}</tbody>
    </table></div>`;

  ensureMoquetteMovementFields();
  bindMovementCalculators();
}

function renderSessionTable(type,heads,rows,label){
  const count=sessionLines[type].length;
  return `<div class="section-divider"></div>
    <div class="section-title">Lignes en attente (${count})</div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      ${count?`<button class="btn ok" onclick="confirmSession('${type}')">Confirmer ${count} ${label}(s)</button>`:''}
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.length?rows.join(''):`<tr><td class="empty" colspan="${heads.length}">Aucune ligne en attente</td></tr>`}</tbody>
    </table></div>`;

  const currentRolls=db.rolls.filter(r=>num(r.currentLength)>0).sort((a,b)=>a.article.localeCompare(b.article)||num(b.currentLength)-num(a.currentLength));
  $('stk-global')?.insertAdjacentHTML('beforeend',`
    <div class="section-divider"></div>
    <div class="panel-head"><div><h2>Rouleaux moquette - stock actuel</h2><p>Vue dÃƒÆ’Ã‚©taillÃƒÆ’Ã‚©e des rouleaux entiers et dÃƒÆ’Ã‚©jÃƒÆ’Ã‚  coupÃƒÆ’Ã‚©s.</p></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Rouleau</th><th>Article</th><th>Couleur</th><th>Site</th><th>Longueur restante</th><th>Largeur</th><th>Statut</th></tr></thead>
      <tbody>${currentRolls.length?currentRolls.map((r,i)=>`<tr><td>${i+1}</td><td>${r.code||r.id}</td><td>${r.article}</td><td>${r.color||'Ãƒ¢â‚¬ââ‚¬'}</td><td>${siteName(r.site)}</td><td><strong>${r.currentLength} cm</strong></td><td>${r.width} cm</td><td><span class="badge ${r.status==='full'?'b-ok':'b-purple'}">${r.status==='full'?'Entier':'Coupe'}</span></td></tr>`).join(''):`<tr><td class="empty" colspan="8">Aucun rouleau moquette en stock</td></tr>`}</tbody>
    </table></div>
    <div class="section-divider"></div>
    <div class="panel-head"><div><h2>Historique des coupes</h2><p>Historique par rouleau des morceaux vendus et des restes generes.</p></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Date</th><th>Rouleau</th><th>Article</th><th>Client</th><th>Site</th><th>Coupe vendue</th><th>Reste</th><th>Total</th><th>Remarque</th></tr></thead>
      <tbody>${db.rollCuts.length?db.rollCuts.slice().sort((a,b)=>b.date.localeCompare(a.date)).map((r,i)=>`<tr><td>${i+1}</td><td>${r.date}</td><td>${r.rollCode||r.rollId}</td><td>${r.article}</td><td>${r.client}</td><td>${siteName(r.site)}</td><td>${r.soldLength} ÃƒÆ’- ${r.width} cm</td><td>${r.remainingLength} ÃƒÆ’- ${r.width} cm</td><td>${dh(r.total)}</td><td>${r.note||'Ãƒ¢â‚¬ââ‚¬'}</td></tr>`).join(''):`<tr><td class="empty" colspan="10">Aucune coupe enregistree</td></tr>`}</tbody>
    </table></div>`);
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ RENDER INVENTORY IMPORT (separe des achats) â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function renderInventoryImport(){
  // Manuel
  $('inv-manual').innerHTML=`
    <div class="panel-head"><div><h2>Ajustement manuel</h2><p>Corrigez manuellement les ecarts de stock. N'affecte pas les achats fournisseurs.</p></div></div>
    <div class="form-grid">
      <div class="field"><label>Date</label><input id="i-date" type="date"></div>
      <div class="field"><label>Article</label><select id="i-article">${opt(db.articles,'Choisir article')}</select></div>
      <div class="field"><label>Site</label><select id="i-site">${opt(db.sites,'Choisir site','id','name')}</select></div>
      <div class="field"><label>Couleur</label><input id="i-color" placeholder="Couleur"></div>
      <div class="field"><label>Longueur</label><input id="i-length" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>Largeur</label><input id="i-width" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>Ajustement (+/-)</label><input id="i-adjust" type="number" step="1" placeholder="Ex: -5 ou +10"></div>
      <div class="field full-col"><label>Motif</label><input id="i-note" placeholder="Raison de l'ajustement"></div>
    </div>
    <div class="summary"><div class="box"><div class="k">Surface ajustee</div><div class="v" id="i-surface">0.00 m2</div></div></div>
    <div class="toolbar">
      <button class="btn primary" onclick="saveInventory()">+ Ajouter ajustement</button>
      <button class="btn" onclick="clearFormInv()">Annuler</button>
    </div>
    ${renderSessionTable('inventory',['#','Date','Article','Site','Couleur','Long.','Larg.','Ajust.','Motif',''],
      sessionLines.inventory.map((r,i)=>`<tr>
        <td>${i+1}</td><td>${r.date}</td><td>${r.article}</td><td>${siteName(r.site)}</td>
        <td>${r.color}</td><td>${r.length}</td><td>${r.width}</td>
        <td><span class="badge ${r.adjust>0?'b-ok':'b-bad'}">${r.adjust>0?'+'+r.adjust:r.adjust}</span></td>
        <td>${r.note||'-'}</td>
        <td><button class="btn sm danger" onclick="removeSessionLine('inventory',${i})">âÅ“â€¢</button></td>
      </tr>`),'inventory')}`;

  // Import Excel ââ€ ' Inventaire
  $('inv-excel').innerHTML=`
    <div class="panel-head"><div><h2>Import Excel ââ€ ' Stock</h2><p>Importez un fichier Excel pour ajouter du stock via inventaire. <strong>Ne compte pas comme achat fournisseur</strong> - aucune ecriture comptable n'est generee.</p></div></div>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:var(--radius);padding:18px;margin-bottom:16px">
      <p style="font-size:13px;margin-bottom:10px"><strong>Format attendu du fichier Excel :</strong></p>
      <p style="font-size:12px;color:var(--mut);line-height:1.8">Colonne A : Nom article<br>Colonne B : Couleur<br>Colonne C : Longueur<br>Colonne D : Largeur<br>Colonne E : Quantite</p>
      <p style="font-size:12px;color:var(--warn);margin-top:8px">Attention La ligne 1 est ignoree (en-tetes). Les donnees commencent a la ligne 2.</p>
    </div>
    <div class="field" style="margin-bottom:8px">
      <label class="checkbox-label"><input type="checkbox" id="xi-full-replacement" onchange="toggleReplacementMode()"> <strong>Mode remplacement complet</strong> &mdash; les quantit&eacute;s import&eacute;es deviennent le NOUVEAU stock de r&eacute;f&eacute;rence (ajustement par &eacute;cart). Les articles non pr&eacute;sents dans le fichier sont remis &agrave; z&eacute;ro.</label>
    </div>
    <div class="form-grid" id="xi-form-grid">
      <div class="field"><label>Date d'import</label><input id="xi-date" type="date" value="${today()}"></div>
      <div class="field"><label>Site destination</label><select id="xi-site">${opt(db.sites,'Choisir site','id','name')}</select></div>
      <div class="field full-col"><label>Motif</label><input id="xi-note" placeholder="Ex: Stock initial, Inventaire physique..." value="Import Excel inventaire"></div>
    </div>
    <div class="toolbar">
      <button class="btn primary" onclick="importExcelInventaire()">Choisir fichier Excel</button>
      <input type="file" id="excel-inv-input" accept=".xlsx" style="display:none">
    </div>
    <div id="inv-excel-preview" style="display:none;margin-top:14px">
      <div class="section-title">Aper&ccedil;u des lignes import&eacute;es</div>
      <div class="table-wrap">
        <table class="table"><thead id="inv-excel-preview-head"><tr><th>#</th><th>Article</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Qte</th><th>Statut</th></tr></thead>
        <tbody id="inv-excel-preview-body"></tbody>
      </table>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn ok" onclick="confirmExcelInventaire()">Confirmer import inventaire</button>
        <button class="btn danger" onclick="cancelExcelInventaire()">Annuler</button>
      </div>
    </div>`;

  // Historique inventaire
  const invHist=[...db.inventories].sort((a,b)=>b.date.localeCompare(a.date));
  $('inv-history').innerHTML=`
    <div class="panel-head"><div><h2>Historique inventaires</h2><p>Tous les ajustements de stock (manuels + imports Excel).</p></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Date</th><th>Article</th><th>Site</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Ajustement</th><th>Motif</th></tr></thead>
      <tbody>${invHist.length?invHist.map((r,i)=>`<tr>
        <td>${i+1}</td><td>${r.date}</td><td>${r.article}</td><td>${siteName(r.site)}</td>
        <td>${r.color||'-'}</td><td>${r.length||0}</td><td>${r.width||0}</td>
        <td><span class="badge ${r.adjust>0?'b-ok':'b-bad'}">${r.adjust>0?'+'+r.adjust:r.adjust}</span></td>
        <td>${r.note||'-'}</td>
      </tr>`).join(''):`<tr><td class="empty" colspan="9">Aucun inventaire</td></tr>`}</tbody>
    </table></div>`;

  bindInvCalculators();
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ EXCEL INVENTAIRE (pas achat) â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
let pendingExcelInventaire=[];
function toggleReplacementMode(){
  const full=$('xi-full-replacement')?.checked;
  const head=$('inv-excel-preview-head');
  if(!head)return;
  if(full){
    head.innerHTML='<tr><th>#</th><th>Article</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Stock actuel</th><th>Qte importee</th><th>Ecart</th><th>Statut</th></tr>';
  }else{
    head.innerHTML='<tr><th>#</th><th>Article</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Qte</th><th>Statut</th></tr>';
  }
}
function importExcelInventaire(){
  const input=$('excel-inv-input');
  const site=$('xi-site').value;
  const date=$('xi-date').value||today();
  const fullReplacement=$('xi-full-replacement')?.checked;
  if(!site){alert('Veuillez choisir un site destination.');return;}
  const doImport=function(){
    input.onchange=async function(e){
      const file=e.target.files[0];if(!file)return;
      try{
        const buf=await file.arrayBuffer();
        const bytes=new Uint8Array(buf);
        const wb=XLSX.read(bytes,{type:'array'});
        const ws=wb.Sheets[wb.SheetNames[0]];
        const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
        pendingExcelInventaire=[];const errors=[];const seenKeys=new Set();
        for(let i=1;i<rows.length;i++){
          const row=rows[i];
          const article=String(row[0]||'').trim();
          const color=String(row[1]||'').trim();
          const length=num(row[2]);const width=num(row[3]);const qty=intv(row[4]);
          if(!article||!color||!length||!width){errors.push(i+1);continue;}
          const key=keyOf(article,color,length,width);
          if(!db.articles.find(a=>a.name===article))db.articles.push({id:uid('art'),name:article,type:'tapis',defaultPm2:0});
          if(fullReplacement){
            const currentStock=stockQty(key,site);
            const diff=qty-currentStock;
            seenKeys.add(key);
            if(diff===0)continue;
            pendingExcelInventaire.push({article,color,length,width,qty:diff,site,date,note:'Remplacement: '+($('xi-note').value||'Import Excel'),key,adjust:diff,status:'OK',_currentStock:currentStock,_importedQty:qty});
          }else{
            if(qty<=0){errors.push(i+1);continue;}
            pendingExcelInventaire.push({article,color,length,width,qty,site,date,note:$('xi-note').value||'Import Excel',key,adjust:qty,status:'OK'});
          }
        }
        // FULL REPLACEMENT MODE: zero out products with stock but not in file
        if(fullReplacement){
          const allSiteKeys=new Set();
          const movements=[...db.purchases,...db.sales.filter(x=>!x.stockIgnore),...db.transfers,...db.inventories];
          const refMap={};
          movements.forEach(x=>{if(x.key&&x.site===site){allSiteKeys.add(x.key);if(!refMap[x.key])refMap[x.key]=x}});
          allSiteKeys.forEach(k=>{
            if(seenKeys.has(k))return;
            const currentStock=stockQty(k,site);
            if(currentStock===0)return;
            const ref=refMap[k];
            pendingExcelInventaire.push({article:ref?.article||'',color:ref?.color||'',length:ref?.length||0,width:ref?.width||0,qty:-currentStock,site,date,note:'Remplacement: article non present dans le fichier (remis a zero)',key:k,adjust:-currentStock,status:'Zero',_currentStock:currentStock,_importedQty:0});
          });
        }
        const body=$('inv-excel-preview-body');
        if(fullReplacement){
          body.innerHTML=pendingExcelInventaire.map((r,i)=>`<tr><td>${i+1}</td><td>${r.article}</td><td>${r.color}</td><td>${r.length}</td><td>${r.width}</td><td>${r._currentStock??'-'}</td><td>${r._importedQty??r.qty}</td><td><span class="badge ${r.adjust>0?'b-ok':r.adjust<0?'b-bad':'b-gray'}">${r.adjust>0?'+'+r.adjust:r.adjust}</span></td><td><span class="badge ${r.status==='Zero'?'b-warn':'b-ok'}">${r.status}</span></td></tr>`).join('');
        }else{
          body.innerHTML=pendingExcelInventaire.map((r,i)=>`<tr><td>${i+1}</td><td>${r.article}</td><td>${r.color}</td><td>${r.length}</td><td>${r.width}</td><td>${r.qty}</td><td><span class="badge b-ok">Pret</span></td></tr>`).join('');
        }
        if(errors.length)body.innerHTML+=`<tr><td colspan="9" class="empty">Attention ${errors.length} ligne(s) ignoree(s) (lignes: ${errors.join(', ')})</td></tr>`;
        $('inv-excel-preview').style.display='block';
        notify(`${pendingExcelInventaire.length} ligne(s) lues. Verifiez et confirmez.`);
      }catch(err){alert('Erreur lecture Excel: '+err.message);}
      input.value='';
    };
    input.click();
  };
  if(typeof XLSX!=='undefined'){doImport();}
  else{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=()=>doImport();s.onerror=()=>alert('Impossible de charger la bibliotheque Excel.');document.head.appendChild(s);}
}
function confirmExcelInventaire(){
  if(!pendingExcelInventaire.length)return;
  pendingExcelInventaire.forEach(r=>db.inventories.push({id:uid('inv'),...r}));
  const count=pendingExcelInventaire.length;
  notify(`${count} ligne(s) ajoutee(s) a l'inventaire (stock mis a jour, historique conserve).`);
  pendingExcelInventaire=[];
  $('inv-excel-preview').style.display='none';
  save();refresh();
}
function cancelExcelInventaire(){
  pendingExcelInventaire=[];
  $('inv-excel-preview').style.display='none';
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ RENDER ACCOUNTS â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function renderAccounts(){
  $('acc-client').innerHTML=renderAccountPanel('client','Compte client');
  $('acc-supplier').innerHTML=renderAccountPanel('supplier','Compte fournisseur');
  bindAccountTools();
}
function renderAccountPanel(type,title){
  const list=type==='client'?db.clients:db.suppliers;
  const selected=view[type+'Account']&&list.some(x=>x.name===view[type+'Account'])?view[type+'Account']:(list[0]?.name||'');
  view[type+'Account']=selected;
  const sum=accountSummary(type,selected);
  const payRows=sum.payments.map((p,i)=>{const due=dueState(p.due);return`<tr><td>${i+1}</td><td>${p.date}</td><td>${dh(p.amount)}</td><td>${p.mode}</td><td>${p.due||'-'}</td><td><span class="badge ${due.cls}">${due.label}</span></td><td><span class="badge ${paymentStatus(p)==='Impaye'?'b-bad':paymentStatus(p)==='DÃƒ'?'b-warn':'b-ok'}">${paymentStatus(p)}</span></td><td>${p.note||'-'}</td></tr>`}).join('');
  const opRows=sum.ops.map((x,i)=>`<tr><td>${i+1}</td><td>${x.date}</td><td>${x.article}</td><td>${x.color||'-'}</td><td>${x.length||0} x ${x.width||0}</td><td>${siteName(x.site)}</td><td>${x.qty}</td><td>${sqm(surface(x.length,x.width,x.qty))}</td><td>${dh(x.pm2)}</td><td style="color:${x.isBuyback?'var(--danger)':'inherit'}">${x.isBuyback?'-'+dh(x.total):dh(x.total)}</td></tr>`).join('');
  const selectHtml=`<option value="">Sélectionner</option>`+list.map(x=>`<option value="${x.name}" ${x.name===selected?'selected':''}>${x.name}</option>`).join('');
  return `<div class="panel-head"><div><h2>${title}</h2><p>Solde = initial + operations âË†' paiements.</p></div></div>
    <div class="form-grid">
      <div class="field"><label>${type==='client'?'Client':'Fournisseur'}</label><select id="${type}-account-select" onchange="setAccountView('${type}',this.value)">${selectHtml}</select></div>
      <div class="field"><label>Date paiement</label><input id="${type}-pay-date" type="date"></div>
      <div class="field"><label>Montant</label><input id="${type}-pay-amount" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>Mode</label><select id="${type}-pay-mode"><option>Cash</option><option>Virement</option><option>LC</option><option>Cheque</option></select></div>
      <div class="field"><label>Delai jours</label><input id="${type}-pay-days" type="number" value="0"></div>
      <div class="field"><label>Echeance</label><input id="${type}-pay-due" type="date"></div>
      <div class="field"><label>Remarque</label><input id="${type}-pay-note" placeholder="Optionnel"></div>
    </div>
    <div class="toolbar">
      <button class="btn primary" onclick="saveAccountPayment('${type}')">Ajouter paiement</button>
      <button class="btn alt" onclick="togglePrintOptions('${type}')">Imprimer</button>
      <button class="btn warn" onclick="shareAccountPDF('${type}')">PDF WhatsApp</button>
    </div>
    <div id="${type}-print-options" style="display:none;background:linear-gradient(135deg,#f0f7ff,#faf5ff);border:1px solid #bfdbfe;border-radius:var(--radius);padding:14px 16px;margin-bottom:14px">
      <div style="font-size:12px;font-weight:700;color:var(--brand);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;display:flex;align-items:center;gap:6px">Impression Options d'impression</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;align-items:end;margin-bottom:10px">
        <div class="field"><label>Date début</label><input id="${type}-print-from" type="date" placeholder="Depuis"></div>
        <div class="field"><label>Date fin</label><input id="${type}-print-to" type="date" placeholder="Jusqu'à" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="field" style="justify-content:flex-end">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:18px">
            <input type="checkbox" id="${type}-print-hide-pm2" style="width:15px;height:15px;cursor:pointer;accent-color:var(--brand)">
            <span style="font-size:12px;font-weight:600;color:var(--ink)">Masquer prix m2</span>
          </label>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" onclick="printAccount('${type}')">Imprimer</button>
        <button class="btn" onclick="document.getElementById('${type}-print-options').style.display='none'">Annuler</button>
      </div>
    </div>
    <div class="summary">
      <div class="box"><div class="k">Solde initial</div><div class="v">${dh(sum.init)}</div></div>
      <div class="box"><div class="k">Total ventes</div><div class="v">${dh(sum.totalSales)}</div></div>
      ${type==='client'&&sum.totalBuybacks>0?`<div class="box"><div class="k">Total rachats</div><div class="v" style="color:var(--danger)">-${dh(sum.totalBuybacks)}</div></div>`:''}
      <div class="box"><div class="k">Total paiements</div><div class="v">${dh(sum.totalPay)}</div></div>
      <div class="box ${num(sum.balance)>0?'':''}"><div class="k">Solde restant</div><div class="v" style="color:${num(sum.balance)>0?'var(--ok)':'var(--danger)'}">${dh(sum.balance)}</div></div>
    </div>
    <div class="section-title">Operations</div>
    <div class="table-wrap" style="margin-bottom:14px"><table class="table"><thead><tr><th>#</th><th>Date</th><th>Article</th><th>Couleur</th><th>Dimensions</th><th>Site</th><th>Qte</th><th>Surface</th><th>Prix m2</th><th>Total</th></tr></thead><tbody>${opRows||`<tr><td class="empty" colspan="10">Aucune operation</td></tr>`}</tbody></table></div>
    <div class="section-title">Paiements</div>
    <div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Date</th><th>Montant</th><th>Mode</th><th>Echeance</th><th>Jours restants</th><th>Statut</th><th>Remarque</th></tr></thead><tbody>${payRows||`<tr><td class="empty" colspan="8">Aucun paiement</td></tr>`}</tbody></table></div>`;
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ RENDER STOCK â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function renderStock(){
  const rows=stockRows().map(r=>({...r,qty:globalQty(r.key),value:stockValue(r.article,globalQty(r.key),r.length,r.width)})).filter(r=>r.qty!==0);

  const totalSurface=rows.reduce((s,r)=>s+surface(r.length,r.width,r.qty),0);
  const totalValue=rows.reduce((s,r)=>s+r.value,0);
  function currentStockRows(){
    const q=($('stk-search')?.value||'').toLowerCase().trim();
    const siteF=$('stk-global-site')?.value||'';
    return stockRows().map(r=>{
      const qty=siteF?stockQty(r.key,siteF):globalQty(r.key);
      return{...r,qty,value:stockValue(r.article,qty,r.length,r.width)};
    }).filter(r=>r.qty!==0&&(q===''||[r.article,r.color,r.length,r.width].join(' ').toLowerCase().includes(q)));
  }
  function renderStockBody(list){
    return list.length?list.map((r,i)=>{
      const recentSales=db.sales.filter(s=>!s.isBuyback&&s.article===r.article).reduce((s,x)=>s+num(x.qty),0);
      const suggest=r.qty<Math.max(2,recentSales)?'RÃƒ©appro conseillÃƒ©':'Stock stable';
      return`<tr data-search="${[r.article,r.color,r.length,r.width].join(' ').toLowerCase()}">
        <td>${i+1}</td><td>${r.article}</td><td>${r.color}</td>
        <td>${r.length} x ${r.width}</td><td><strong>${r.qty}</strong></td>
        <td>${sqm(surface(r.length,r.width,r.qty))}</td><td>${dh(r.value)}</td>
        <td><span class="badge ${suggest==='RÃƒ©appro conseillÃƒ©'?'b-warn':'b-ok'}">${suggest}</span></td>
      </tr>`;}).join(''):`<tr><td class="empty" colspan="8">Aucun stock disponible</td></tr>`;
  }

  $('stk-global').innerHTML=`
    <div class="panel-head"><div><h2>Vue globale du stock</h2><p>Stock total toutes références.</p></div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
      <div style="background:linear-gradient(135deg,#eff6ff,#dbeafe);border:1px solid #bfdbfe;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#1e40af;font-weight:700">Total superficie en stock</div>
        <div id="stk-total-surface" style="font-size:24px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#1a56db;margin-top:4px">${sqm(totalSurface)}</div>
      </div>
      <div style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #a7f3d0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#065f46;font-weight:700">Valeur totale du stock</div>
        <div id="stk-total-value" style="font-size:24px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#059669;margin-top:4px">${dh(totalValue)}</div>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:14px;align-items:flex-end">
      <div class="field" style="flex:2">
        <label>Recherche</label>
        <input id="stk-search" placeholder="Rechercher par article, couleur, dimensions..." oninput="filterStock()" style="width:100%">
      </div>
      <div class="field" style="flex:1">
        <label>Filtrer par site</label>
        <select id="stk-global-site" onchange="filterStock()">
          <option value="">Tous les sites</option>
          ${db.sites.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="table-wrap"><table class="table" id="stk-global-table">
      <thead><tr><th>#</th><th>Article</th><th>Couleur</th><th>Dimensions</th><th>Qte</th><th>Surface</th><th>Valeur</th><th>Suggestion</th></tr></thead>
      <tbody id="stk-global-body">${rows.length?rows.map((r,i)=>{
        const recentSales=db.sales.filter(s=>!s.isBuyback&&s.article===r.article).reduce((s,x)=>s+num(x.qty),0);
        const suggest=r.qty<Math.max(2,recentSales)?'Réappro conseillé':'Stock stable';
        // Compute site ids that have this item
        const siteIds=db.sites.map(s=>s.id).filter(sid=>stockQty(r.key,sid)>0).join(',');
        return`<tr data-search="${[r.article,r.color,r.length,r.width].join(' ').toLowerCase()}" data-sites="${siteIds}">
          <td>${i+1}</td><td>${r.article}</td><td>${r.color}</td>
          <td>${r.length} x ${r.width}</td><td><strong>${r.qty}</strong></td>
          <td>${sqm(surface(r.length,r.width,r.qty))}</td><td>${dh(r.value)}</td>
          <td><span class="badge ${suggest==='Réappro conseillé'?'b-warn':'b-ok'}">${suggest}</span></td>
        </tr>`;}).join(''):`<tr><td class="empty" colspan="8">Aucun stock disponible</td></tr>`}</tbody>
    </table></div>`;

  window.filterStock=function(){
    const filtered=currentStockRows();
    $('stk-global-body').innerHTML=renderStockBody(filtered);
    $('stk-total-surface').textContent=sqm(filtered.reduce((s,r)=>s+surface(r.length,r.width,r.qty),0));
    $('stk-total-value').textContent=dh(filtered.reduce((s,r)=>s+r.value,0));
  };
  window.filterStock();

  const siteFilter=($('stk-site-filter')?.value)||'';
  const siteRows=db.sites.map(site=>stockRows().map(r=>({...r,siteObj:site,site:site.name,qty:stockQty(r.key,site.id),value:stockValue(r.article,stockQty(r.key,site.id),r.length,r.width)})).filter(r=>r.qty!==0)).flat();

  if($('stk-sites'))$('stk-sites').innerHTML=`
    <div class="panel-head"><div><h2>Stock par site</h2><p>Filtrez par site pour voir les quantites locales.</p></div></div>
    <div class="form-grid tight" style="margin-bottom:14px">
      <div class="field"><label>Site</label><select id="stk-site-filter" onchange="renderStock()"><option value="">Tous les sites</option>${db.sites.map(s=>`<option value="${s.id}" ${s.id===siteFilter?'selected':''}>${s.name}</option>`).join('')}</select></div>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Site</th><th>Article</th><th>Couleur</th><th>Dimensions</th><th>Qte</th><th>Surface</th><th>Valeur</th></tr></thead>
      <tbody>${siteRows.filter(r=>!siteFilter||r.siteObj?.id===siteFilter).length?
        siteRows.filter(r=>!siteFilter||r.siteObj?.id===siteFilter).map((r,i)=>`<tr>
          <td>${i+1}</td><td>${r.site}</td><td>${r.article}</td><td>${r.color}</td>
          <td>${r.length} x ${r.width}</td><td><strong>${r.qty}</strong></td>
          <td>${sqm(surface(r.length,r.width,r.qty))}</td><td>${dh(r.value)}</td>
        </tr>`).join(''):`<tr><td class="empty" colspan="8">Aucun stock</td></tr>`}
      </tbody>
    </table></div>`;

  const aiRows=rows.filter(r=>r.qty>0||db.sales.some(s=>!s.isBuyback&&s.article===r.article)).map(r=>{
    const sold=db.sales.filter(s=>!s.isBuyback&&s.article===r.article).reduce((s,x)=>s+num(x.qty),0);
    const bought=db.purchases.filter(p=>p.article===r.article).reduce((s,x)=>s+num(x.qty),0);
    const imported=db.inventories.filter(iv=>iv.article===r.article&&iv.adjust>0).reduce((s,x)=>s+num(x.adjust),0);
    const score=sold>0?((sold+1)/(Math.max(1,r.qty))).toFixed(2):'0.00';
    const suggestion=sold===0?'Pas assez d\'historique':r.qty<sold?'Commander rapidement':r.qty<sold*2?'Prévoir réappro':'RAS';
    return{article:r.article,color:r.color,length:r.length,width:r.width,stock:r.qty,sold,bought,imported,score,suggestion};
  }).sort((a,b)=>parseFloat(b.score)-parseFloat(a.score));

  $('stk-ai').innerHTML=`
    <div class="panel-head"><div><h2>Suggestions reapprovisionnement</h2><p>Base sur les ventes cumulees vs stock actuel. Les imports Excel inventaire sont exclus des "achats".</p></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Article</th><th>Couleur</th><th>Dim.</th><th>Stock</th><th>Ventes</th><th>Achats</th><th>Import inv.</th><th>Score</th><th>Suggestion</th></tr></thead>
      <tbody>${aiRows.length?aiRows.map((r,i)=>`<tr>
        <td>${i+1}</td><td>${r.article}</td><td>${r.color||'-'}</td>
        <td>${r.length||0} x ${r.width||0}</td><td><strong>${r.stock}</strong></td>
        <td>${r.sold}</td><td>${r.bought}</td><td>${r.imported}</td><td>${r.score}</td>
        <td><span class="badge ${r.suggestion==='Commander rapidement'?'b-bad':r.suggestion==='Prévoir réappro'?'b-warn':r.suggestion==='RAS'?'b-ok':'b-gray'}">${r.suggestion}</span></td>
      </tr>`).join(''):`<tr><td class="empty" colspan="10">Pas assez de donnees</td></tr>`}</tbody>
    </table></div>`;
  renderRollPanels();
}

function renderRollPanels(){
  const currentRolls=db.rolls.filter(r=>num(r.currentLength)>0).sort((a,b)=>a.article.localeCompare(b.article)||num(b.currentLength)-num(a.currentLength));
  $('stk-global')?.insertAdjacentHTML('beforeend',`
    <div class="section-divider"></div>
    <div class="panel-head"><div><h2>Rouleaux moquette - stock actuel</h2><p>Vue detaillee des rouleaux entiers et deja coupes.</p></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Rouleau</th><th>Article</th><th>Couleur</th><th>Site</th><th>Longueur restante</th><th>Largeur</th><th>Statut</th></tr></thead>
      <tbody>${currentRolls.length?currentRolls.map((r,i)=>`<tr><td>${i+1}</td><td>${r.code||r.id}</td><td>${r.article}</td><td>${r.color||'-'}</td><td>${siteName(r.site)}</td><td><strong>${r.currentLength} cm</strong></td><td>${r.width} cm</td><td><span class="badge ${r.status==='full'?'b-ok':'b-purple'}">${r.status==='full'?'Entier':'Coupe'}</span></td></tr>`).join(''):`<tr><td class="empty" colspan="8">Aucun rouleau moquette en stock</td></tr>`}</tbody>
    </table></div>
    <div class="section-divider"></div>
    <div class="panel-head"><div><h2>Historique des coupes</h2><p>Historique par rouleau des morceaux vendus et des restes generes.</p></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Date</th><th>Rouleau</th><th>Article</th><th>Client</th><th>Site</th><th>Coupe vendue</th><th>Reste</th><th>Total</th><th>Remarque</th></tr></thead>
      <tbody>${db.rollCuts.length?db.rollCuts.slice().sort((a,b)=>b.date.localeCompare(a.date)).map((r,i)=>`<tr><td>${i+1}</td><td>${r.date}</td><td>${r.rollCode||r.rollId}</td><td>${r.article}</td><td>${r.client}</td><td>${siteName(r.site)}</td><td>${r.soldLength} x ${r.width} cm</td><td>${r.remainingLength} x ${r.width} cm</td><td>${dh(r.total)}</td><td>${r.note||'-'}</td></tr>`).join(''):`<tr><td class="empty" colspan="10">Aucune coupe enregistree</td></tr>`}</tbody>
    </table></div>`);
}

let analyticsPeriod=30;
function renderAnalytics(){
  const periodLabel={7:'7 jours',30:'30 jours',90:'3 mois',180:'6 mois',365:'1 an',0:'Tout'};

  // â"â‚¬â"â‚¬ TOP VENTES â"â‚¬â"â‚¬
  const sales=db.sales.filter(s=>!s.isBuyback&&dateInPeriod(s.date,analyticsPeriod||0));
  const saleByArticle={};
  sales.forEach(s=>{
    if(!saleByArticle[s.article])saleByArticle[s.article]={article:s.article,qty:0,total:0,count:0};
    saleByArticle[s.article].qty+=num(s.qty);
    saleByArticle[s.article].total+=num(s.total);
    saleByArticle[s.article].count++;
  });
  const topSales=Object.values(saleByArticle).sort((a,b)=>b.total-a.total).slice(0,10);
  const maxTotal=topSales[0]?.total||1;

  const saleByClient={};
  sales.forEach(s=>{
    if(!saleByClient[s.client])saleByClient[s.client]={client:s.client,total:0,count:0};
    saleByClient[s.client].total+=num(s.total);
    saleByClient[s.client].count++;
  });
  const topClients=Object.values(saleByClient).sort((a,b)=>b.total-a.total).slice(0,5);

  const periodBtns=Object.entries(periodLabel).map(([d,l])=>`<button class="period-btn${analyticsPeriod==d?' active':''}" onclick="analyticsPeriod=${d};renderAnalytics()">${l}</button>`).join('');

  $('ana-topsales').innerHTML=`
    <div class="panel-head"><div><h2>Produits les plus vendus</h2><p>Classement par chiffre d'affaires sur la periode choisie.</p></div></div>
    <div class="period-filter"><label>Periode :</label>${periodBtns}</div>
    <div class="analytics-grid">
      <div class="analytics-card">
        <h4>Top articles par CA</h4>
        ${topSales.length?topSales.map((r,i)=>`<div class="rank-item">
          <div class="rank-num ${i===0?'gold':i===1?'silver':i===2?'bronze':''}">${i+1}</div>
          <div class="rank-info">
            <div class="rank-name">${r.article}</div>
            <div class="rank-sub">${r.qty} unites - ${r.count} vente(s)</div>
            <div class="bar-wrap"><div class="bar-fill" style="width:${Math.round(r.total/maxTotal*100)}%"></div></div>
          </div>
          <div class="rank-val">${dh(r.total)}</div>
        </div>`).join(''):'<p style="color:var(--mut);text-align:center;padding:20px">Aucune vente sur cette periode</p>'}
      </div>
      <div class="analytics-card">
        <h4>Top clients</h4>
        ${topClients.length?topClients.map((r,i)=>`<div class="rank-item">
          <div class="rank-num ${i===0?'gold':i===1?'silver':i===2?'bronze':''}">${i+1}</div>
          <div class="rank-info"><div class="rank-name">${r.client}</div><div class="rank-sub">${r.count} commande(s)</div></div>
          <div class="rank-val">${dh(r.total)}</div>
        </div>`).join(''):'<p style="color:var(--mut);text-align:center;padding:20px">Aucun client sur cette periode</p>'}
      </div>
    </div>
    <div class="analytics-card">
      <h4>Tableau detaille des ventes</h4>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Rang</th><th>Article</th><th>Qte vendue</th><th>Nb. transactions</th><th>CA total</th></tr></thead>
        <tbody>${topSales.map((r,i)=>`<tr><td><span class="badge b-brand">#${i+1}</span></td><td>${r.article}</td><td>${r.qty}</td><td>${r.count}</td><td><strong>${dh(r.total)}</strong></td></tr>`).join('')||`<tr><td class="empty" colspan="5">Aucune vente</td></tr>`}</tbody>
      </table></div>
    </div>`;

  // â"â‚¬â"â‚¬ ROTATION STOCK â"â‚¬â"â‚¬
  const rotRows=stockRows().map(r=>{
    const stock=globalQty(r.key);
    const soldInPeriod=db.sales.filter(s=>s.article===r.article&&!s.isBuyback&&(!analyticsPeriod||dateInPeriod(s.date,analyticsPeriod))).reduce((s,x)=>s+num(x.qty),0);
    const periodDays=analyticsPeriod||365;
    const rotationAnnuelle=stock>0?(soldInPeriod/stock*(365/periodDays)):0;
    const joursStockage=soldInPeriod>0?Math.round(stock/soldInPeriod*periodDays):null;
    let rotClass,rotLabel;
    if(soldInPeriod===0){rotClass='rot-dead';rotLabel='Inactif'}
    else if(rotationAnnuelle>=12){rotClass='rot-fast';rotLabel='Tres rapide'}
    else if(rotationAnnuelle>=6){rotClass='rot-medium';rotLabel='Moyen'}
    else{rotClass='rot-slow';rotLabel='Lente'}
    return{...r,stock,soldInPeriod,rotationAnnuelle:rotationAnnuelle.toFixed(1),joursStockage,rotClass,rotLabel};
  }).filter(r=>r.stock>0||r.soldInPeriod>0).sort((a,b)=>parseFloat(b.rotationAnnuelle)-parseFloat(a.rotationAnnuelle));

  $('ana-rotation').innerHTML=`
    <div class="panel-head"><div><h2>Rotation du stock</h2><p>Indice de rotation = ventes / stock moyen x (365 / jours periode)</p></div></div>
    <div class="period-filter"><label>Periode :</label>${periodBtns}</div>
    <div class="summary">
      <div class="box"><div class="k">Articles analyses</div><div class="v">${rotRows.length}</div></div>
      <div class="box"><div class="k">Rotation rapide (&gt;12)</div><div class="v" style="color:var(--ok)">${rotRows.filter(r=>r.rotClass==='rot-fast').length}</div></div>
      <div class="box"><div class="k">Rotation lente (&lt;6)</div><div class="v" style="color:var(--warn)">${rotRows.filter(r=>r.rotClass==='rot-slow').length}</div></div>
      <div class="box"><div class="k">Inactifs (0 vente)</div><div class="v" style="color:var(--danger)">${rotRows.filter(r=>r.rotClass==='rot-dead').length}</div></div>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Article</th><th>Couleur</th><th>Dim.</th><th>Stock actuel</th><th>Ventes periode</th><th>Rotation/an</th><th>Jours de stock</th><th>Vitesse</th></tr></thead>
      <tbody>${rotRows.length?rotRows.map((r,i)=>`<tr>
        <td>${i+1}</td><td>${r.article}</td><td>${r.color||'-'}</td><td>${r.length} x ${r.width}</td>
        <td>${r.stock}</td><td>${r.soldInPeriod}</td>
        <td><strong>${r.rotationAnnuelle}x</strong></td>
        <td>${r.joursStockage!==null?r.joursStockage+'j':'-'}</td>
        <td><span class="rotation-badge ${r.rotClass}">${r.rotLabel}</span></td>
      </tr>`).join(''):`<tr><td class="empty" colspan="9">Aucune donnee de stock</td></tr>`}</tbody>
    </table></div>`;

  // â"â‚¬â"â‚¬ VITESSE DE ROTATION â"â‚¬â"â‚¬
  $('ana-vitesse').innerHTML=`
    <div class="panel-head"><div><h2>âš¡ Vitesse de rotation</h2><p>Jours moyens pour ecouler le stock actuel au rythme de vente actuel.</p></div></div>
    <div class="period-filter"><label>Periode :</label>${periodBtns}</div>
    <div class="analytics-grid">
      <div class="analytics-card">
        <h4>Articles a rotation rapide</h4>
        ${rotRows.filter(r=>r.rotClass==='rot-fast').slice(0,6).map((r,i)=>`<div class="rank-item">
          <div class="rank-num gold">${i+1}</div>
          <div class="rank-info"><div class="rank-name">${r.article}</div><div class="rank-sub">${r.color||''} ${r.length}x${r.width}</div></div>
          <div style="text-align:right"><div class="rank-val">${r.rotationAnnuelle}x/an</div><div style="font-size:11px;color:var(--ok)">${r.joursStockage||'?'}j de stock</div></div>
        </div>`).join('')||'<p style="color:var(--mut);text-align:center;padding:20px">Aucun article a rotation rapide</p>'}
      </div>
      <div class="analytics-card">
        <h4>Attention Articles dormants / lents</h4>
        ${rotRows.filter(r=>r.rotClass==='rot-slow'||r.rotClass==='rot-dead').slice(0,6).map((r,i)=>`<div class="rank-item">
          <div class="rank-num" style="background:var(--danger-bg);color:var(--danger)">${i+1}</div>
          <div class="rank-info"><div class="rank-name">${r.article}</div><div class="rank-sub">${r.color||''} ${r.length}x${r.width}</div></div>
          <div style="text-align:right"><div class="rank-val" style="color:var(--danger)">${r.rotationAnnuelle}x/an</div><div style="font-size:11px;color:var(--mut)">${r.joursStockage||'âË†Å¾'}j de stock</div></div>
        </div>`).join('')||'<p style="color:var(--mut);text-align:center;padding:20px">Aucun article lent - bravo !</p>'}
      </div>
    </div>
    <div style="background:var(--brand-light);border:1px solid #bfdbfe;border-radius:var(--radius);padding:16px;margin-top:4px">
      <h4 style="font-size:13px;font-weight:700;color:var(--brand);margin-bottom:8px">Conseils automatiques</h4>
      <ul style="font-size:13px;color:var(--ink);line-height:2;list-style:none;padding:0">
        ${rotRows.filter(r=>r.rotClass==='rot-dead').length?`<li>Attention <strong>${rotRows.filter(r=>r.rotClass==='rot-dead').length} article(s)</strong> sans aucune vente sur la periode - envisagez un destockage ou une promotion.</li>`:''}
        ${rotRows.filter(r=>r.rotClass==='rot-fast'&&(r.joursStockage||0)<14).length?`<li>Urgent <strong>${rotRows.filter(r=>r.rotClass==='rot-fast'&&(r.joursStockage||0)<14).length} article(s)</strong> ont moins de 14 jours de stock restant - reapprovisionnez en urgence.</li>`:''}
        ${rotRows.filter(r=>r.rotClass==='rot-slow'&&r.stock>10).length?`<li>Stock <strong>${rotRows.filter(r=>r.rotClass==='rot-slow'&&r.stock>10).length} article(s)</strong> ont un stock eleve avec une rotation lente - evitez de sur-commander.</li>`:''}
        ${!rotRows.filter(r=>r.rotClass==='rot-dead').length&&!rotRows.filter(r=>r.rotClass==='rot-fast'&&(r.joursStockage||0)<14).length?'<li>Votre gestion de stock semble equilibree sur la periode selectionnee.</li>':''}
      </ul>
    </div>`;

  // â"â‚¬â"â‚¬ RAPPORT ECRIT CONSEILS â"â‚¬â"â‚¬
  const now_r=new Date();
  const periodName=periodLabel[analyticsPeriod]||'Tout';
  const totalCA=sales.reduce((s,x)=>s+num(x.total),0);
  const totalQty=sales.reduce((s,x)=>s+num(x.qty),0);
  const totalPurchasePeriod=db.purchases.filter(p=>dateInPeriod(p.date,analyticsPeriod||0)).reduce((s,x)=>s+num(x.total),0);
  const marge=totalCA-totalPurchasePeriod;
  const txMarge=totalCA>0?((marge/totalCA)*100).toFixed(1):0;
  const produitsInteressants=topSales.filter(r=>r.total>0).map(r=>{
    const rot=rotRows.find(x=>x.article===r.article);
    return{...r,rotation:rot?.rotationAnnuelle||'0',rotClass:rot?.rotClass||'rot-dead',joursStock:rot?.joursStockage};
  }).filter(r=>parseFloat(r.rotation)>=6).slice(0,5);
  const produitsRisque=rotRows.filter(r=>r.rotClass==='rot-slow'||r.rotClass==='rot-dead').sort((a,b)=>b.stock-a.stock).slice(0,5);
  const urgentReappro=rotRows.filter(r=>r.rotClass==='rot-fast'&&(r.joursStockage||0)<14);
  const meilleurClient=topClients[0];
  const rapportDate=now_r.toLocaleDateString('fr-MA',{day:'2-digit',month:'long',year:'numeric'});

  if($('ana-rapport'))$('ana-rapport').innerHTML=`
    <div class="panel-head"><div><h2>Rapport & Conseils Produits</h2><p>Analyse automatique - Periode : ${periodName} - Genere le ${rapportDate}</p></div>
      <div class="panel-actions"><div class="period-filter" style="margin:0"><label>Periode :</label>${periodBtns}</div></div>
    </div>
    <div style="background:linear-gradient(135deg,#1a56db,#7c3aed);border-radius:14px;padding:20px;color:#fff;margin-bottom:16px">
      <h3 style="font-size:16px;font-weight:700;margin-bottom:12px;opacity:.9">Resume executif - ${periodName}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
        <div style="background:rgba(255,255,255,.12);border-radius:10px;padding:12px"><div style="font-size:10px;opacity:.7;text-transform:uppercase">Chiffre d'affaires</div><div style="font-size:20px;font-weight:700;margin-top:4px">${dh(totalCA)}</div></div>
        <div style="background:rgba(255,255,255,.12);border-radius:10px;padding:12px"><div style="font-size:10px;opacity:.7;text-transform:uppercase">Unites vendues</div><div style="font-size:20px;font-weight:700;margin-top:4px">${totalQty}</div></div>
        <div style="background:rgba(255,255,255,.12);border-radius:10px;padding:12px"><div style="font-size:10px;opacity:.7;text-transform:uppercase">Achats periode</div><div style="font-size:20px;font-weight:700;margin-top:4px">${dh(totalPurchasePeriod)}</div></div>
        <div style="background:rgba(255,255,255,.12);border-radius:10px;padding:12px"><div style="font-size:10px;opacity:.7;text-transform:uppercase">Marge brute estimée</div><div style="font-size:20px;font-weight:700;margin-top:4px;color:${marge>=0?'#6ee7b7':'#fca5a5'}">${dh(marge)} (${txMarge}%)</div></div>
      </div>
    </div>
    <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:14px;padding:18px;margin-bottom:14px">
      <h3 style="font-size:15px;font-weight:700;color:#065f46;margin-bottom:10px">Produits Interessants - À Valoriser</h3>
      ${produitsInteressants.length?`<p style="font-size:13px;color:#047857;margin-bottom:12px;line-height:1.7">Ces produits combinent une bonne rotation et un chiffre d'affaires significatif. Ce sont vos <strong>locomotives commerciales</strong> - assurez-vous d'avoir toujours du stock disponible.</p>
      ${produitsInteressants.map((r,i)=>`<div style="background:#fff;border:1px solid #a7f3d0;border-radius:10px;padding:14px;margin-bottom:10px;display:flex;align-items:flex-start;gap:14px">
        <div style="width:32px;height:32px;background:#059669;color:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">${i+1}</div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700;color:#065f46">${r.article}</div>
          <div style="font-size:12px;color:#047857;margin-top:4px">unites - CA CA : ${dh(r.total)} - ðŸ”„ Rotation : ${r.rotation}x/an - â± ${r.joursStock||'?'}j de stock</div>
          <div style="font-size:12px;color:#374151;margin-top:6px;line-height:1.6;background:#f0fdf4;border-radius:6px;padding:8px"><strong>Conseil :</strong> ${parseFloat(r.rotation)>=12?`Ce produit tourne tres vite. Commandez en avance - rupture de stock possible sous ${r.joursStock||'peu de'} jours.`:`Produit stable et porteur. Maintenez un stock confortable et negociez un meilleur prix grÃƒ¢ce au volume.`}</div>
        </div></div>`).join('')}`:`<p style="color:#047857;font-size:13px;padding:10px 0">Pas assez de donnees pour identifier des produits interessants sur cette periode.</p>`}
    </div>
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:14px;padding:18px;margin-bottom:14px">
      <h3 style="font-size:15px;font-weight:700;color:#991b1b;margin-bottom:10px">Attention Produits a Risque - Stock Dormant</h3>
      ${produitsRisque.length?`<p style="font-size:13px;color:#b91c1c;margin-bottom:12px;line-height:1.7">Ces produits ont un stock important mais se vendent peu. Ils immobilisent votre trésorerie. Une action commerciale ciblée est recommandée.</p>
      ${produitsRisque.map(r=>`<div style="background:#fff;border:1px solid #fecaca;border-radius:10px;padding:14px;margin-bottom:10px;display:flex;align-items:flex-start;gap:14px">
        <div style="width:32px;height:32px;background:#dc2626;color:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">!</div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700;color:#991b1b">${r.article} <span style="font-size:11px;font-weight:400">${r.color||''} - ${r.length}x${r.width}</span></div>
          <div style="font-size:12px;color:#b91c1c;margin-top:4px">Stock : ${r.stock} - Ventes Ventes : ${r.soldInPeriod} - ðŸ”„ ${r.rotationAnnuelle}x/an</div>
          <div style="font-size:12px;color:#374151;margin-top:6px;line-height:1.6;background:#fff7f7;border-radius:6px;padding:8px"><strong>Conseil :</strong> ${r.rotClass==='rot-dead'?`Aucune vente sur la periode. Envisagez une promotion agressive, un retour fournisseur, ou un transfert vers un site plus actif.`:`Rotation lente. Evitez de renouveler avant d'ecouler le stock. Un geste commercial (remise 10ââ‚¬"15%) peut accelerer les ventes.`}</div>
        </div></div>`).join('')}`:`<p style="color:#b91c1c;font-size:13px;padding:10px 0">Aucun produit dormant identifie - bonne gestion !</p>`}
    </div>
    ${urgentReappro.length?`<div style="background:#fff7ed;border:1px solid #fdba74;border-radius:14px;padding:18px;margin-bottom:14px">
      <h3 style="font-size:15px;font-weight:700;color:#9a3412;margin-bottom:10px">Reapprovisionnement Urgent (&lt;14j)</h3>
      ${urgentReappro.map(r=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #fed7aa"><span style="font-size:18px">âš¡</span><div><strong>${r.article}</strong> ${r.color||''} - <strong>${r.joursStockage||'?'}j</strong> de stock restant - Rotation ${r.rotationAnnuelle}x/an</div></div>`).join('')}
    </div>`:''}
    ${meilleurClient?`<div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:14px;padding:18px;margin-bottom:14px">
      <h3 style="font-size:15px;font-weight:700;color:#5b21b6;margin-bottom:8px">â­ Client Prioritaire</h3>
      <p style="font-size:13px;color:#6d28d9;line-height:1.7"><strong>${meilleurClient.client}</strong> est votre meilleur client sur la periode avec <strong>${dh(meilleurClient.total)}</strong> en <strong>${meilleurClient.count} commande(s)</strong>. Accordez-lui une attention commerciale particuliere : tarifs preferentiels, stock prioritaire, fidelisation proactive.</p>
    </div>`:''}
    <div style="background:#f8fafc;border:1px solid var(--line);border-radius:14px;padding:18px">
      <h3 style="font-size:13px;font-weight:700;color:var(--mut);margin-bottom:8px">Note de synthese</h3>
      <p style="font-size:13px;color:var(--ink);line-height:1.8">Ce rapport est genere automatiquement a partir de vos donnees GestStock. Les conseils sont bases sur les ratios de rotation de stock et les tendances de vente. Pour affiner l'analyse, assurez-vous que toutes vos operations sont bien enregistrees et que vos prix fournisseurs sont a jour.</p>
    </div>`;
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ METRICS â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function updateMetrics(){
  const totalPurchase=db.purchases.reduce((s,x)=>s+num(x.total),0)+db.sales.filter(x=>x.isBuyback).reduce((s,x)=>s+num(x.total),0);
  const totalSale=db.sales.filter(x=>!x.isBuyback).reduce((s,x)=>s+num(x.total),0);
  const stock=stockRows().reduce((s,r)=>s+globalQty(r.key),0);
  const surfaceTotal=stockRows().reduce((s,r)=>s+surface(r.length,r.width,globalQty(r.key)),0);
  $('m-articles').textContent=db.articles.length;
  $('m-sites').textContent=db.sites.length;
  $('m-purchases').textContent=dh(totalPurchase);
  $('m-sales').textContent=dh(totalSale);
  $('m-stock').textContent=stock;
  $('m-surface').textContent=sqm(surfaceTotal);
}

function sanitizeVisibleText(){
  const replacements=[['m2','m2']];
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const nodes=[];
  while(walker.nextNode())nodes.push(walker.currentNode);
  nodes.forEach(node=>{
    let text=node.nodeValue;
    let next=text;
    const hadBrokenEncoding=/[Ãâð�]/.test(text);
    replacements.forEach(([a,b])=>{next=next.split(a).join(b)});
    if(hadBrokenEncoding||/[Ãâð�]/.test(next))next=next.replace(/[^\x00-\x7F]/g,'').replace(/\s+/g,' ').trim();
    if(next!==text)node.nodeValue=next;
  });
}
let sanitizeObserverStarted=false;
function startSanitizeObserver(){
  if(sanitizeObserverStarted)return;
  sanitizeObserverStarted=true;
  let timer=null;
  new MutationObserver(()=>{
    clearTimeout(timer);
    timer=setTimeout(sanitizeVisibleText,30);
  }).observe(document.body,{childList:true,subtree:true,characterData:true});
}

async function saveUser(){
  if(!requireAdmin())return;
  const name=norm($('f-user-name')?.value).toLowerCase();
  const role=$('f-user-role')?.value==='admin'?'admin':'visitor';
  const password=$('f-user-password')?.value||'';
  if(!name||!password)return alert('Nom et mot de passe requis');
  if(password.length<8)return alert('Mot de passe trop court : utilisez au moins 8 caracteres.');
  if(['1234','0000','admin','password','visiteur'].includes(password.toLowerCase()))return alert('Mot de passe trop faible pour une application professionnelle.');
  const passwordHash=await sha256(password);
  const existing=users.find(u=>u.name.toLowerCase()===name);
  if(existing){existing.role=role;existing.passwordHash=passwordHash;}
  else users.push({id:uid('usr'),name,role,passwordHash});
  save();refresh();notify('Utilisateur enregistre');
}
function deleteUser(id){
  if(!requireAdmin())return;
  if(users.length<=1)return alert('Gardez au moins un utilisateur.');
  const u=users.find(x=>x.id===id);
  if(u?.id===currentUser?.id)return alert('Vous ne pouvez pas supprimer l utilisateur connecte.');
  if(!confirm('Supprimer cet utilisateur ?'))return;
  users=users.filter(u=>u.id!==id);
  save();refresh();notify('Utilisateur supprime');
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ CRUD FUNCS â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function saveArticle(){const name=norm($('f-article-name').value),type=$('f-article-type')?.value||'tapis',defaultPm2=num($('f-article-default').value);if(!name)return alert('Nom article requis');if(edit.article<0)db.articles.push({id:uid('art'),name,type,defaultPm2});else db.articles[edit.article]={...db.articles[edit.article],name,type,defaultPm2};clearForm('article');save();refresh();notify('Article enregistré')}
function saveClient(){const name=norm($('f-client-name').value),city=norm($('f-client-city').value),initial=num($('f-client-initial').value);if(!name||!city)return alert('Nom et ville requis');if(edit.client<0)db.clients.push({id:uid('cli'),name,city,initial});else db.clients[edit.client]={...db.clients[edit.client],name,city,initial};clearForm('client');save();refresh();notify('Client enregistre')}
function saveSupplier(){const name=norm($('f-supplier-name').value),city=norm($('f-supplier-city').value),initial=num($('f-supplier-initial').value);if(!name||!city)return alert('Nom et ville requis');if(edit.supplier<0)db.suppliers.push({id:uid('sup'),name,city,initial});else db.suppliers[edit.supplier]={...db.suppliers[edit.supplier],name,city,initial};clearForm('supplier');save();refresh();notify('Fournisseur enregistre')}
function saveSite(){const name=norm($('f-site-name').value),city=norm($('f-site-city').value);if(!name||!city)return alert('Nom et ville requis');if(edit.site<0)db.sites.push({id:uid('site'),name,city});else db.sites[edit.site]={...db.sites[edit.site],name,city};clearForm('site');save();refresh();notify('Site enregistre')}
function saveClientPrice(){const client=$('f-cp-client').value,article=$('f-cp-article').value,pm2=num($('f-cp-pm2').value);if(!client||!article||pm2<=0)return alert('Client, article, prix requis');if(edit.cp<0)db.clientPrices.push({id:uid('cp'),client,article,pm2});else db.clientPrices[edit.cp]={...db.clientPrices[edit.cp],client,article,pm2};clearForm('cp');save();refresh();notify('Prix client enregistre')}
function saveSupplierPrice(){const supplier=$('f-sp-supplier').value,article=$('f-sp-article').value,pm2=num($('f-sp-pm2').value);if(!supplier||!article||pm2<=0)return alert('Fournisseur, article, prix requis');if(edit.sp<0)db.supplierPrices.push({id:uid('sp'),supplier,article,pm2});else db.supplierPrices[edit.sp]={...db.supplierPrices[edit.sp],supplier,article,pm2};clearForm('sp');save();refresh();notify('Prix fournisseur enregistre')}
function savePurchase(){
  const supplier=$('p-supplier').value,article=$('p-article').value,site=$('p-site').value,
    color=norm($('p-color').value),length=num($('p-length').value),width=num($('p-width').value),
    qty=intv($('p-qty').value),pm2=num($('p-pm2').value),date=$('p-date').value,note=norm($('p-note').value);
  if(!supplier||!article||!site||!date||!color||!length||!width||qty<=0||pm2<=0)return alert('Champs achat incomplets');
  if(isMoquetteArticle(article)&&length<=800)return alert('Pour un article Moquette, la longueur du rouleau doit etre superieure a 800 cm.');
  const key=keyOf(article,color,length,width),total=surface(length,width,qty)*pm2;
  sessionLines.purchase.push({supplier,article,site,color,length,width,qty,pm2,date,note,key,total});
  const saved={supplier,article,site,color,length,width,pm2,date,note};
  renderMovements();
  Object.entries(saved).forEach(([k,v])=>{const el=$(`p-${k}`);if(el)el.value=v});
  $('p-qty').value='';
  notify('Ligne ajoutee - cliquez Confirmer pour enregistrer');
}
function saveSale(){
  const horsStockChecked=$('s-hors-stock')?.checked||false;
  const client=$('s-client').value,article=$('s-article').value,site=horsStockChecked?'':($('s-site')?.value||''),
    color=norm($('s-color').value),length=num($('s-length').value),width=num($('s-width').value),
    qty=intv($('s-qty').value),pm2=num($('s-pm2').value),date=$('s-date').value,note=norm($('s-note').value);
  if(!horsStockChecked&&(!client||!article||!site||!date||!color||!length||!width||qty<=0||pm2<=0))return alert('Champs vente incomplets');
  if(isMoquetteArticle(article)){
    const rollId=$('s-roll')?.value;
    const roll=getRollById(rollId);
    if(!roll)return alert('Choisissez le rouleau a couper.');
    const available=Math.max(0,num(roll.currentLength)-pendingRollUsage(roll.id));
    if(length>available)return alert(`Longueur insuffisante sur ce rouleau. Disponible: ${available} cm`);
    const total=surface(length,width,1)*pm2;
    sessionLines.sale.push({
      client,article,site,color,length,width,qty:1,pm2,date,note,
      key:keyOf(article,color,length,width),total,
      moquetteSale:true,stockIgnore:true,rollId:roll.id,rollCode:roll.code,
      sourceLength:available,remainingLength:available-length,sourceKey:keyOf(article,color,available,width)
    });
    const saved={client,article,site,color,width,pm2,date,note};
    renderMovements();
    Object.entries(saved).forEach(([k,v])=>{const el=$(`s-${k}`);if(el)el.value=v});
    if($('s-roll'))$('s-roll').value=roll.id;
    $('s-qty').value='1';$('s-length').value='';
    if(window.onSaleRollChange)window.onSaleRollChange();
    notify('Coupe moquette ajoutee - cliquez Confirmer pour enregistrer');
    return;
  }
  const horsStock=horsStockChecked;
  if(horsStock){
    // Mode libre: pas de site, pas de stock check, article/couleur/long/larg en texte libre
    if(!client||!article||!date||!color||!length||!width||qty<=0||pm2<=0)return alert('Champs vente incomplets (Client, Article, Couleur, Long., Larg., Qte, Prix m2 requis)');
    const key=keyOf(article,color,length,width);
    const total=surface(length,width,qty)*pm2;
    const feeNames=['transport','frais transport','frais couture','couture','surgi','surgi moquette','emballage'];
    const isFee=feeNames.includes(article.toLowerCase());
    sessionLines.sale.push({client,article,site:'',color,length,width,qty,pm2,date,note,key,total,stockIgnore:true,horsStock:true,isFee,feeType:isFee?article:''});
    renderMovements();
    // Restore hors-stock checkbox and free fields state after re-render
    if($('s-hors-stock')){$('s-hors-stock').checked=true;window.onHorsStockChange();}
    const saved={client,color,length,width,pm2,date,note};
    Object.entries(saved).forEach(([k,v])=>{const el=$(`s-${k}`);if(el)el.value=v});
    if($('s-article'))$('s-article').value=article;
    $('s-qty').value='';
    notify('Ligne hors stock ajoutee - cliquez Confirmer pour enregistrer');
    return;
  }
  const key=keyOf(article,color,length,width);
  if(stockQty(key,site)<qty)return alert(`Stock insuffisant sur ce site. Disponible: ${stockQty(key,site)}\n\nSi cet article est hors stock, cochez la case "Article hors stock" pour enregistrer sans affecter le stock.`);
  const total=surface(length,width,qty)*pm2;
  sessionLines.sale.push({client,article,site,color,length,width,qty,pm2,date,note,key,total,stockIgnore:false,horsStock:false});
  const saved={client,article,site,color,length,width,pm2,date,note};
  renderMovements();
  Object.entries(saved).forEach(([k,v])=>{const el=$(`s-${k}`);if(el)el.value=v});
  $('s-qty').value='';
  notify('Ligne ajoutee - cliquez Confirmer pour enregistrer');
}
function saveBuyback(){
  const client=$('b-client').value,article=$('b-article').value,site=$('b-site').value,
    color=norm($('b-color').value),length=num($('b-length').value),width=num($('b-width').value),
    qty=intv($('b-qty').value),pm2=num($('b-pm2').value),date=$('b-date').value,note=norm($('b-note').value);
  if(!client||!article||!site||!date||!color||!length||!width||qty<=0||pm2<=0)return alert('Champs rachat incomplets');
  if(isMoquetteArticle(article))return alert('Le rachat de moquette n\'est pas supporte.');
  const key=keyOf(article,color,length,width),total=surface(length,width,qty)*pm2;
  sessionLines.buyback.push({client,article,site,color,length,width,qty,pm2,date,note,key,total,isBuyback:true});
  const saved={client,article,site,color,length,width,pm2,date,note};
  renderMovements();
  Object.entries(saved).forEach(([k,v])=>{const el=$(`b-${k}`);if(el)el.value=v});
  $('b-qty').value='';
  notify('Ligne de rachat ajoutee - cliquez Confirmer pour enregistrer');
}
// ----- HORS STOCK MODE -----
window.onHorsStockChange=function(){
  const hs=$('s-hors-stock')?.checked;
  if(!hs){
    // Restore normal mode: replace free inputs with selects
    const articleField=$('s-article-field');
    if(articleField&&articleField.querySelector('input')){
      const val=articleField.querySelector('input').value;
      articleField.innerHTML=`<label>Article</label><select id="s-article" onchange="onSaleArticleChange()">${opt(db.articles,'Article')}</select>`;
      // try restore value
      if($('s-article'))$('s-article').value=val;
    }
    const colorField=$('s-color-field');
    if(colorField&&colorField.querySelector('input')){
      const val=colorField.querySelector('input').value;
      colorField.innerHTML=`<label>Couleur</label><select id="s-color"><option value="">-- Selectionner couleur --</option></select>`;
    }
    const dimField=$('s-dim-field');
    if(dimField&&dimField.style.display==='none'){
      dimField.style.display='';
    }
    // Show site field
    const siteField=$('s-site-field');
    if(siteField)siteField.style.display='';
    // Show stock dispo box
    const dispBox=$('s-stock-dispo-box');
    if(dispBox)dispBox.style.display='';
    // Lock length/width
    const sl=$('s-length'),sw=$('s-width');
    if(sl){sl.readOnly=true;sl.style.background='#f0f4f9';}
    if(sw){sw.readOnly=true;sw.style.background='#f0f4f9';}
    bindMovementCalculators();
    return;
  }
  // HORS STOCK MODE: free text for article, color, length, width; hide site, dim select
  const articleField=$('s-article-field');
  if(articleField){
    const curVal=$('s-article')?.value||'';
    articleField.innerHTML=`<label>Article (libre)</label><input id="s-article" type="text" placeholder="Nom article" value="${curVal}">`;
  }
  const colorField=$('s-color-field');
  if(colorField){
    colorField.innerHTML=`<label>Couleur (libre)</label><input id="s-color" type="text" placeholder="Couleur">`;
  }
  const dimField=$('s-dim-field');
  if(dimField)dimField.style.display='none';
  // Hide site field
  const siteField=$('s-site-field');
  if(siteField)siteField.style.display='none';
  // Hide stock dispo box
  const dispBox=$('s-stock-dispo-box');
  if(dispBox)dispBox.style.display='none';
  bindMovementCalculators();
  // IMPORTANT: re-unlock length/width AFTER bindMovementCalculators (which may lock them via onSaleArticleChange)
  const sl=$('s-length'),sw=$('s-width');
  if(sl){sl.readOnly=false;sl.style.background='';sl.style.cursor='';}
  if(sw){sw.readOnly=false;sw.style.background='';sw.style.cursor='';}
  // Also re-unlock qty (moquette logic may have locked it)
  const sq=$('s-qty');
  if(sq){sq.readOnly=false;sq.style.background='';}
};

function saveTransfer(){
  const article=$('t-article').value,from=$('t-from').value,to=$('t-to').value,
    color=norm($('t-color').value),length=num($('t-length').value),width=num($('t-width').value),
    qty=intv($('t-qty').value),date=$('t-date').value,note=norm($('t-note').value);
  if(!article||!from||!to||from===to||!date||!color||!length||!width||qty<=0)return alert('Champs transfert incomplets');
  const key=keyOf(article,color,length,width);
  if(stockQty(key,from)<qty)return alert(`Stock insuffisant au site source. Disponible: ${stockQty(key,from)}`);
  sessionLines.transfer.push({article,from,to,color,length,width,qty,date,note,key});
  const saved={article,from,to,color,length,width,date,note};
  renderMovements();
  Object.entries(saved).forEach(([k,v])=>{const el=$(`t-${k}`);if(el)el.value=v});
  $('t-qty').value='';
  notify('Transfert ajoute - cliquez Confirmer pour enregistrer');
}
function saveInventory(){
  const article=$('i-article').value,site=$('i-site').value,
    color=norm($('i-color').value),length=num($('i-length').value),width=num($('i-width').value),
    adjust=intv($('i-adjust').value),date=$('i-date').value,note=norm($('i-note').value);
  if(!article||!site||!date||!color||!length||!width||adjust===0)return alert('Champs inventaire incomplets');
  const key=keyOf(article,color,length,width);
  sessionLines.inventory.push({article,site,color,length,width,adjust,date,note,key});
  const saved={article,site,color,length,width,date,note};
  renderInventoryImport();
  Object.entries(saved).forEach(([k,v])=>{const el=$(`i-${k}`);if(el)el.value=v});
  $('i-adjust').value='';
  notify('Ajustement ajoute - cliquez Confirmer pour enregistrer');
}
let pendingPayment=null;
function saveAccountPayment(type){
  const name=$(type+'-account-select').value,date=$(type+'-pay-date').value,
    amount=num($(type+'-pay-amount').value),mode=$(type+'-pay-mode').value,
    due=$(type+'-pay-due').value,note=norm($(type+'-pay-note').value);
  if(!name||!date||amount<=0)return alert('Paiement incomplet');
  // If mode with due date (LC or Cheque) and due is in future - show effect modal
  if((mode==='LC'||mode==='Cheque')&&due){
    const dueDate=new Date(due);const today_=new Date();today_.setHours(0,0,0,0);dueDate.setHours(0,0,0,0);
    if(dueDate>today_){
      pendingPayment={type,name,date,amount,mode,due,note};
      $('effect-modal-detail').innerHTML=`
        <strong>${type==='client'?'Client':'Fournisseur'} :</strong> ${name}<br>
        <strong>Montant :</strong> ${dh(amount)}<br>
        <strong>Mode :</strong> ${mode}<br>
        <strong>Echeance :</strong> ${due}<br>
        <strong>Jours restants :</strong> ${Math.round((dueDate-today_)/86400000)}j`;
      $('effect-modal').style.display='flex';
      return;
    }
  }
  doSavePayment({type,name,date,amount,mode,due,note,deductNow:true});
}
function doSavePayment(p){
  if(!requireAdmin())return;
  const row={id:uid('pay'),type:p.type,name:p.name,date:p.date,amount:p.amount,mode:p.mode,due:p.due||'',note:p.note,deductNow:p.deductNow,paidStatus:p.paidStatus||''};
  row.paidStatus=normalizedPaymentStatus(row);
  db.payments.push(row);
  // Clear form
  const type=p.type;
  $(type+'-pay-amount').value='';$(type+'-pay-note').value='';$(type+'-pay-due').value='';$(type+'-pay-days').value='0';
  save();refresh();notify('Paiement ajoute');
}
function clearForm(type){
  if(type==='article')edit.article=-1;if(type==='client')edit.client=-1;
  if(type==='supplier')edit.supplier=-1;if(type==='site')edit.site=-1;
  if(type==='cp')edit.cp=-1;if(type==='sp')edit.sp=-1;
  refresh();
}
function clearFormMv(type){renderMovements()}
function clearFormInv(){renderInventoryImport()}
function editArticle(i){edit.article=i;refresh()}
function editClientRow(i){edit.client=i;refresh()}
function editSupplierRow(i){edit.supplier=i;refresh()}
function editSiteRow(i){edit.site=i;refresh()}
function editClientPrice(i){edit.cp=i;refresh()}
function editSupplierPrice(i){edit.sp=i;refresh()}
function removeRow(name,i){if(!confirm('Supprimer cet élément ?'))return;db[name].splice(i,1);save();refresh();notify('Supprimé')}
function removeSite(i){const id=db.sites[i].id;const used=[...db.purchases,...db.sales].some(x=>x.site===id)||db.transfers.some(x=>x.from===id||x.to===id)||db.inventories.some(x=>x.site===id);if(used)return alert('Site utilise dans les operations - suppression impossible.');db.sites.splice(i,1);save();refresh()}
function removeSessionLine(type,i){sessionLines[type].splice(i,1);if(type==='inventory')renderInventoryImport();else renderMovements();}
function setAccountView(type,value){view[type+'Account']=value;refresh()}

// ===== EDIT DELETE =====
function operationArrayName(type){return{purchase:'purchases',sale:'sales',buyback:'sales',transfer:'transfers',inventory:'inventories',payment:'payments'}[type]||type}
function recalcOperationRow(type,r){
  if(['purchase','sale','buyback','transfer','inventory'].includes(type))r.key=keyOf(r.article,r.color,r.length,r.width);
  if(type==='purchase'||type==='sale'||type==='buyback')r.total=surface(r.length,r.width,r.qty)*num(r.pm2);
}
function editOperationRow(type,id){
  if(!requireAdmin())return;
  const arr=db[operationArrayName(type)]||[];
  const r=arr.find(x=>x.id===id);
  if(!r)return;
  if(type==='sale'&&r.moquetteSale){
    alert('Une vente moquette modifie le rouleau et l inventaire. Pour garder un stock fiable, supprimez la vente puis recréez la coupe.');
    return;
  }
  const before=JSON.parse(JSON.stringify(r));
  const fields=type==='payment'
    ?['date','amount','mode','due','note']
    :type==='transfer'
      ?['date','article','color','length','width','qty','from','to','note']
      :type==='inventory'
        ?['date','article','site','color','length','width','adjust','note']
        :['date',type==='purchase'?'supplier':'client','article','site','color','length','width','qty','pm2','note'];
  fields.forEach(f=>{
    const next=prompt(`Modifier ${f}`,r[f]??'');
    if(next===null)return;
    r[f]=['length','width','qty','pm2','amount','adjust'].includes(f)?num(next):next;
  });
  recalcOperationRow(type,r);
  normalizePayments();
  auditOperation('edit',type,before,r);
  save();refresh();notify('Operation modifiee');
}
function deleteOperationRow(type,id){
  if(!requireAdmin())return;
  if(!confirm('Supprimer cette operation ?'))return;
  const name=operationArrayName(type);
  const before=(db[name]||[]).find(x=>x.id===id);
  auditOperation('delete',type,before,null);
  if(type==='sale'&&before?.moquetteSale)removeMoquetteEffects(before);
  db[name]=(db[name]||[]).filter(x=>x.id!==id);
  save();refresh();notify('Operation supprimee');
}
function editPayment(id){editOperationRow('payment',id)}
function deletePayment(id){deleteOperationRow('payment',id)}
function setPaymentPaidStatus(id,status){
  if(!requireAdmin())return;
  const p=db.payments.find(x=>x.id===id);
  if(!p)return;
  const before=JSON.parse(JSON.stringify(p));
  p.paidStatus=status;
  p.deductNow=status==='paid';
  auditOperation('payment_status','payment',before,p);
  save();refresh();notify(status==='paid'?'Paiement marque paye':'Paiement marque impaye');
}
function togglePaymentPaid(id){
  const p=db.payments.find(x=>x.id===id);
  if(!p)return;
  setPaymentPaidStatus(id,normalizedPaymentStatus(p)==='paid'?'unpaid':'paid');
}
function opButtons(type,id){return`<button class="btn sm alt" onclick="editOperationRow('${type}','${id}')">Edit</button> <button class="btn sm danger" onclick="deleteOperationRow('${type}','${id}')">Delete</button>`}
function paymentButtons(id){return`<button class="btn sm alt" onclick="editPayment('${id}')">Edit payment</button> <button class="btn sm danger" onclick="deletePayment('${id}')">Delete payment</button> <button class="btn sm ok" onclick="setPaymentPaidStatus('${id}','paid')">Mark as PAID</button> <button class="btn sm" onclick="setPaymentPaidStatus('${id}','unpaid')">Mark as UNPAID</button>`}
function addTableActions(table,rows,htmlForRow){
  if(!table||table.dataset.safeActions==='1')return;
  table.dataset.safeActions='1';
  table.querySelector('thead tr')?.insertAdjacentHTML('beforeend','<th>Actions</th>');
  table.querySelectorAll('tbody tr').forEach((tr,i)=>{
    if(tr.querySelector('.empty')){tr.querySelector('.empty').colSpan=(tr.children.length||1)+1;return;}
    const row=rows[i];
    tr.insertAdjacentHTML('beforeend',`<td>${row?htmlForRow(row):''}</td>`);
  });
}
function enhanceOperationTables(){
  const hist=[
    ...db.purchases.map(x=>({...x,_safeType:'purchase'})),
    ...db.sales.map(x=>({...x,_safeType:'sale'})),
    ...db.transfers.map(x=>({...x,_safeType:'transfer'}))
  ].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  addTableActions($('mv-history')?.querySelector('table'),hist,r=>opButtons(r._safeType,r.id));
  const invHist=[...db.inventories].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  addTableActions($('inv-history')?.querySelector('table'),invHist,r=>opButtons('inventory',r.id));
  ['client','supplier'].forEach(type=>{
    const name=view[type+'Account'];if(!name)return;
    const sum=accountSummary(type,name);
    const tables=$(type==='client'?'acc-client':'acc-supplier')?.querySelectorAll('table');
    addTableActions(tables?.[0],sum.ops,r=>opButtons(type==='client'?'sale':'purchase',r.id));
    addTableActions(tables?.[1],sum.payments,r=>paymentButtons(r.id));
  });
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ EDIT LINE MODAL â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
let editLineState={type:'',index:-1};
function openEditLine(type,i){
  const r=sessionLines[type][i];
  editLineState={type,index:i};
  $('edit-line-title').textContent=`Modifier ligne ${i+1}`;
  $('edit-line-sub').textContent=type==='purchase'?'Achat fournisseur':type==='buyback'?'Rachat client':'Vente client';
  const fields=[
    {id:'el-date',label:'Date',type:'date',val:r.date},
    {id:'el-color',label:'Couleur',type:'text',val:r.color},
    {id:'el-length',label:'Longueur',type:'number',val:r.length},
    {id:'el-width',label:'Largeur',type:'number',val:r.width},
    {id:'el-qty',label:'Quantite',type:'number',val:r.qty},
    {id:'el-pm2',label:'Prix m2',type:'number',val:r.pm2},
    {id:'el-note',label:'Remarque',type:'text',val:r.note||''},
  ];
  $('edit-line-fields').innerHTML=fields.map(f=>`<div class="field"><label>${f.label}</label><input id="${f.id}" type="${f.type}" value="${f.val}" step="${f.type==='number'?'0.01':''}"></div>`).join('');
  $('edit-line-modal').style.display='flex';
}
$('edit-line-save').addEventListener('click',function(){
  if(!requireAdmin())return;
  const{type,index}=editLineState;if(index<0)return;
  const r=sessionLines[type][index];
  r.date=$('el-date').value||r.date;
  r.color=$('el-color').value||r.color;
  r.length=num($('el-length').value)||r.length;
  r.width=num($('el-width').value)||r.width;
  r.qty=intv($('el-qty').value)||r.qty;
  r.pm2=num($('el-pm2').value)||r.pm2;
  r.note=$('el-note').value;
  if(r.moquetteSale){
    const roll=getRollById(r.rollId);
    const available=roll?Math.max(0,num(roll.currentLength)-(sessionLines[type].filter((x,idx)=>x.rollId===r.rollId&&idx!==index).reduce((s,x)=>s+num(x.length),0))):num(r.sourceLength);
    if(num(r.length)>available){alert(`Longueur insuffisante sur ce rouleau. Disponible: ${available} cm`);return;}
    r.qty=1;
    r.width=roll?num(roll.width):num(r.width);
    r.sourceLength=available;
    r.remainingLength=available-num(r.length);
    r.sourceKey=keyOf(r.article,r.color,r.sourceLength,r.width);
    r.stockIgnore=true;
  }
  r.key=keyOf(r.article,r.color,r.length,r.width);
  r.total=surface(r.length,r.width,r.qty)*r.pm2;
  $('edit-line-modal').style.display='none';
  renderMovements();
  notify('Ligne modifiee');
});

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ CONFIRM SESSION â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function confirmSession(type){
  if(!sessionLines[type].length)return;
  const titles={purchase:'Confirmer les achats',sale:'Confirmer les ventes',transfer:'Confirmer les transferts',inventory:'Confirmer les ajustements',buyback:'Confirmer les rachats clients'};
  const counts=sessionLines[type].length;
  $('confirm-modal-title').textContent=titles[type];
  $('confirm-modal-desc').textContent=`${counts} ligne(s) vont etre enregistrees definitivement.`;
  let thead='',tbody='';
  if(type==='purchase'){thead='<tr><th>#</th><th>Date</th><th>Fournisseur</th><th>Article</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Qte</th><th>Total</th></tr>';tbody=sessionLines.purchase.map((r,i)=>`<tr><td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.supplier)}</td><td>${h(r.article)}</td><td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.qty)}</td><td>${dh(r.total)}</td></tr>`).join('');}
  else if(type==='sale'){thead='<tr><th>#</th><th>Date</th><th>Client</th><th>Article</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Qte</th><th>Total</th></tr>';tbody=sessionLines.sale.map((r,i)=>`<tr><td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.client)}</td><td>${h(r.article)}</td><td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.qty)}</td><td>${dh(r.total)}</td></tr>`).join('');}
  else if(type==='transfer'){thead='<tr><th>#</th><th>Date</th><th>Article</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Qte</th><th>De</th><th>Vers</th></tr>';tbody=sessionLines.transfer.map((r,i)=>`<tr><td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.article)}</td><td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.qty)}</td><td>${h(siteName(r.from))}</td><td>${h(siteName(r.to))}</td></tr>`).join('');}
   else if(type==='inventory'){thead='<tr><th>#</th><th>Date</th><th>Article</th><th>Site</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Ajust.</th></tr>';tbody=sessionLines.inventory.map((r,i)=>`<tr><td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.article)}</td><td>${h(siteName(r.site))}</td><td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.adjust>0?'+'+r.adjust:r.adjust)}</td></tr>`).join('');}
   else if(type==='buyback'){thead='<tr><th>#</th><th>Date</th><th>Client</th><th>Article</th><th>Couleur</th><th>Long.</th><th>Larg.</th><th>Qte</th><th>Total</th></tr>';tbody=sessionLines.buyback.map((r,i)=>`<tr><td>${i+1}</td><td>${h(r.date)}</td><td>${h(r.client)}</td><td>${h(r.article)}</td><td>${h(r.color)}</td><td>${h(r.length)}</td><td>${h(r.width)}</td><td>${h(r.qty)}</td><td>${dh(r.total)}</td></tr>`).join('');}
  $('confirm-modal-thead').innerHTML=thead;
  $('confirm-modal-tbody').innerHTML=tbody;
  confirmCallback=function(){
    if(type==='purchase')sessionLines.purchase.forEach(r=>{
      db.purchases.push({id:uid('pur'),...r});
      if(isMoquetteArticle(r.article)){
        for(let i=0;i<intv(r.qty);i++){
          db.rolls.push({
            id:uid('roll'),
            code:`ROL-${Date.now().toString().slice(-6)}-${i+1}-${db.rolls.length+1}`,
            article:r.article,color:r.color,width:r.width,originalLength:r.length,currentLength:r.length,
            site:r.site,purchaseDate:r.date,purchaseRef:r.id||'',status:'full',note:r.note||''
          });
        }
      }
    });
    else if(type==='sale')sessionLines.sale.forEach(r=>{
      if(r.moquetteSale){
        const saleId=uid('sale');
        db.sales.push({id:saleId,...r});
        db.inventories.push({id:uid('inv'),sourceSaleId:saleId,article:r.article,site:r.site,color:r.color,length:r.sourceLength,width:r.width,adjust:-1,date:r.date,note:`Sortie rouleau ${r.rollCode||r.rollId}`,key:keyOf(r.article,r.color,r.sourceLength,r.width)});
        if(num(r.remainingLength)>0){
          db.inventories.push({id:uid('inv'),sourceSaleId:saleId,article:r.article,site:r.site,color:r.color,length:r.remainingLength,width:r.width,adjust:1,date:r.date,note:`Reste rouleau ${r.rollCode||r.rollId}`,key:keyOf(r.article,r.color,r.remainingLength,r.width)});
        }
        const roll=getRollById(r.rollId);
        if(roll){
          roll.currentLength=Math.max(0,num(r.remainingLength));
          roll.status=roll.currentLength>0?'partial':'sold';
        }
        db.rollCuts.push({id:uid('cut'),sourceSaleId:saleId,rollId:r.rollId,rollCode:r.rollCode||'',article:r.article,color:r.color,width:r.width,site:r.site,client:r.client,date:r.date,soldLength:r.length,previousLength:r.sourceLength,remainingLength:Math.max(0,num(r.remainingLength)),pm2:r.pm2,total:r.total,note:r.note||''});
        return;
      }
      db.sales.push({id:uid('sale'),...r});
    });
    else if(type==='buyback')sessionLines.buyback.forEach(r=>{
      db.sales.push({id:uid('sale'),...r,isBuyback:true});
    });
    else if(type==='transfer')sessionLines.transfer.forEach(r=>db.transfers.push({id:uid('tr'),...r}));
    else if(type==='inventory')sessionLines.inventory.forEach(r=>db.inventories.push({id:uid('inv'),...r}));
    sessionLines[type]=[];
    $('confirm-modal').style.display='none';
    save();refresh();notify(`${counts} ligne(s) enregistree(s) avec succes !`);
  };
  $('confirm-modal').style.display='flex';
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ CALCULATORS â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function ensureMoquetteMovementFields(){
  const saleGrid=$('mv-sale')?.querySelector('.form-grid.tight');
  if(saleGrid&&!$('s-roll-wrap')){
    const colorField=$('s-color')?.closest('.field');
    colorField?.insertAdjacentHTML('afterend',`<div class="field" id="s-roll-wrap" style="display:none"><label>Rouleau ÃƒÆ’Ã‚  couper</label><select id="s-roll"><option value="">-- SÃƒÆ’Ã‚©lectionner rouleau --</option></select></div>`);
    saleGrid.insertAdjacentHTML('beforeend',`<div id="s-roll-hint" class="full-col" style="display:none;font-size:12px;color:var(--mut);background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:10px 12px">Article Moquette: choisissez manuellement le rouleau ÃƒÆ’Ã‚  couper. La vente dÃƒÆ’Ã‚©duira ce rouleau et crÃƒÆ’Ã‚©era automatiquement le morceau restant en stock.</div>`);
  }
}
function bindMovementCalculators(){
  const purchaseCalc=()=>{
    const supplier=$('p-supplier')?.value,article=$('p-article')?.value;
    const l=num($('p-length')?.value),w=num($('p-width')?.value),q=intv($('p-qty')?.value);
    if(supplier&&article){const p=entityPrice('supplier',supplier,article);if(p&&!$('p-pm2').value)$('p-pm2').value=p}
    if($('p-surface'))$('p-surface').textContent=sqm(surface(l,w,q));
    if($('p-total'))$('p-total').textContent=dh(surface(l,w,q)*num($('p-pm2')?.value));
  };
  ['p-supplier','p-article'].forEach(id=>$(id)?.addEventListener('change',purchaseCalc));
  ['p-color','p-length','p-width','p-qty','p-pm2'].forEach(id=>$(id)?.addEventListener('input',purchaseCalc));
  if($('p-date'))$('p-date').value=today();purchaseCalc();

  // SALE: dynamic dropdowns
  window.onSaleArticleChange=function(){
    const article=$('s-article')?.value;
    const colorSel=$('s-color');const dimSel=$('s-dim');
    if(!colorSel||!dimSel)return;
    // Get unique colors from stock for this article
    const keys=stockRows().filter(r=>r.article===article&&globalQty(r.key)>0);
    const colors=[...new Set(keys.map(r=>r.color))].filter(Boolean);
    colorSel.innerHTML='<option value="">-- Selectionner couleur --</option>'+colors.map(c=>`<option value="${c}">${c}</option>`).join('');
    dimSel.innerHTML='<option value="">-- Selectionner dim. --</option>';
    $('s-length').value='';$('s-width').value='';
    if($('s-stock-dispo'))$('s-stock-dispo').textContent='-';
  };
  window.onSaleColorChange=function(){
    const article=$('s-article')?.value,color=$('s-color')?.value;
    const dimSel=$('s-dim');if(!dimSel)return;
    if(!article||!color){dimSel.innerHTML='<option value="">-- Selectionner dim. --</option>';return;}
    const keys=stockRows().filter(r=>r.article===article&&r.color===color&&globalQty(r.key)>0);
    dimSel.innerHTML='<option value="">-- Selectionner dim. --</option>'+keys.map(r=>{
      const site=$('s-site')?.value;const q=site?stockQty(r.key,site):globalQty(r.key);
      return`<option value="${r.length}|${r.width}">${r.length} x ${r.width} cm (stock: ${q})</option>`;
    }).join('');
    $('s-length').value='';$('s-width').value='';
  };
  window.onSaleDimChange=function(){
    const val=$('s-dim')?.value;
    if(!val){$('s-length').value='';$('s-width').value='';return;}
    const[l,w]=val.split('|');
    $('s-length').value=l;$('s-width').value=w;
    // Update stock dispo
    const article=$('s-article')?.value,color=$('s-color')?.value,site=$('s-site')?.value;
    if(article&&color&&l&&w){
      const key=keyOf(article,color,num(l),num(w));
      const q=site?stockQty(key,site):globalQty(key);
      if($('s-stock-dispo')){$('s-stock-dispo').textContent=q+' unités';$('s-stock-dispo').style.color=q>0?'var(--ok)':'var(--danger)';}
    }
    saleCalc();
  };

  // Bind sale dropdowns
  $('s-article')?.addEventListener('change',()=>{onSaleArticleChange();saleCalc();});
  $('s-color')?.addEventListener('change',()=>{onSaleColorChange();saleCalc();});
  $('s-dim')?.addEventListener('change',()=>{onSaleDimChange();});
  $('s-site')?.addEventListener('change',()=>{onSaleColorChange();saleCalc();});

  const saleCalc=()=>{
    const client=$('s-client')?.value,article=$('s-article')?.value;
    const l=num($('s-length')?.value),w=num($('s-width')?.value),q=intv($('s-qty')?.value);
    if(client&&article){const p=entityPrice('client',client,article);if(p&&!$('s-pm2').value)$('s-pm2').value=p}
    if($('s-surface'))$('s-surface').textContent=sqm(surface(l,w,q));
    if($('s-total-box'))$('s-total-box').textContent=dh(surface(l,w,q)*num($('s-pm2')?.value));
  };
  ['s-client'].forEach(id=>$(id)?.addEventListener('change',saleCalc));
  ['s-length','s-qty','s-pm2'].forEach(id=>$(id)?.addEventListener('input',saleCalc));
  if($('s-date'))$('s-date').value=today();saleCalc();

  // Init sale article dropdowns if article already selected
  if($('s-article')?.value)onSaleArticleChange();
  if($('s-roll'))$('s-roll').addEventListener('change',()=>{if(window.onSaleRollChange)window.onSaleRollChange();});
  if($('s-length'))$('s-length').addEventListener('input',()=>{if(isMoquetteArticle($('s-article')?.value))saleCalc();});

  window.onSaleArticleChange=function(){
    // Guard: si mode hors-stock actif, ne pas modifier les champs ni le readOnly
    if($('s-hors-stock')?.checked){saleCalc();return;}
    const article=$('s-article')?.value;
    const colorSel=$('s-color'),dimSel=$('s-dim'),rollWrap=$('s-roll-wrap'),rollHint=$('s-roll-hint');
    if(!colorSel||!dimSel)return;
    const moquette=isMoquetteArticle(article);
    if(rollWrap)rollWrap.style.display=moquette?'':'none';
    if(rollHint)rollHint.style.display=moquette?'block':'none';
    dimSel.closest('.field').style.display=moquette?'none':'';
    $('s-length').value='';$('s-width').value='';
    $('s-length').readOnly=!moquette;
    $('s-length').style.background=moquette?'#fff':'#f0f4f9';
    $('s-width').readOnly=true;
    $('s-width').style.background='#f0f4f9';
    $('s-qty').readOnly=moquette;
    $('s-qty').style.background=moquette?'#f0f4f9':'#fff';
    if(moquette){$('s-qty').value='1';if($('s-roll'))$('s-roll').innerHTML='<option value="">-- SÃƒÆ’Ã‚©lectionner rouleau --</option>';}
    const colors=moquette
      ? [...new Set(getAvailableRolls(article,'',$('s-site')?.value).map(r=>r.color))].filter(Boolean)
      : [...new Set(stockRows().filter(r=>r.article===article&&globalQty(r.key)>0).map(r=>r.color))].filter(Boolean);
    colorSel.innerHTML='<option value="">-- SÃƒÆ’Ã‚©lectionner couleur --</option>'+colors.map(c=>`<option value="${c}">${c}</option>`).join('');
    dimSel.innerHTML='<option value="">-- SÃƒÆ’Ã‚©lectionner dim. --</option>';
    if($('s-stock-dispo'))$('s-stock-dispo').textContent='Ãƒ¢â‚¬ââ‚¬';
    saleCalc();
  };
  window.onSaleColorChange=function(){
    const article=$('s-article')?.value,color=$('s-color')?.value,dimSel=$('s-dim');
    if(!article||!color){if(dimSel)dimSel.innerHTML='<option value="">-- SÃƒÆ’Ã‚©lectionner dim. --</option>';if($('s-roll'))$('s-roll').innerHTML='<option value="">-- SÃƒÆ’Ã‚©lectionner rouleau --</option>';return;}
    if(isMoquetteArticle(article)){
      const rolls=getAvailableRolls(article,color,$('s-site')?.value);
      if($('s-roll'))$('s-roll').innerHTML='<option value="">-- SÃƒÆ’Ã‚©lectionner rouleau --</option>'+rolls.map(r=>`<option value="${r.id}">${rollLabel(r)}</option>`).join('');
      $('s-length').value='';$('s-width').value='';
      if($('s-stock-dispo')){$('s-stock-dispo').textContent=`${rolls.length} rouleau(x) disponible(s)`;$('s-stock-dispo').style.color=rolls.length?'var(--ok)':'var(--danger)';}
      saleCalc();
      return;
    }
    const keys=stockRows().filter(r=>r.article===article&&r.color===color&&globalQty(r.key)>0);
    if(dimSel)dimSel.innerHTML='<option value="">-- SÃƒÆ’Ã‚©lectionner dim. --</option>'+keys.map(r=>{const site=$('s-site')?.value;const q=site?stockQty(r.key,site):globalQty(r.key);return`<option value="${r.length}|${r.width}">${r.length} ÃƒÆ’- ${r.width} cm (stock: ${q})</option>`;}).join('');
    $('s-length').value='';$('s-width').value='';
    saleCalc();
  };
  window.onSaleRollChange=function(){
    const roll=getRollById($('s-roll')?.value);
    if(!roll){$('s-width').value='';if($('s-stock-dispo'))$('s-stock-dispo').textContent='Ãƒ¢â‚¬ââ‚¬';return;}
    const available=Math.max(0,num(roll.currentLength)-pendingRollUsage(roll.id));
    $('s-width').value=roll.width;
    if($('s-stock-dispo')){$('s-stock-dispo').textContent=`Reste ${available} cm sur ${roll.code||roll.id}`;$('s-stock-dispo').style.color=available>0?'var(--ok)':'var(--danger)';}
    saleCalc();
  };
  if($('s-article')?.value)window.onSaleArticleChange();

  const transferCalc=()=>{const l=num($('t-length')?.value),w=num($('t-width')?.value),q=intv($('t-qty')?.value);if($('t-surface'))$('t-surface').textContent=sqm(surface(l,w,q))};
  ['t-article','t-color','t-length','t-width','t-qty'].forEach(id=>$(id)?.addEventListener('input',transferCalc));
  if($('t-date'))$('t-date').value=today();transferCalc();

  // BUYBACK calculators
  const buybackCalc=()=>{
    const client=$('b-client')?.value,article=$('b-article')?.value;
    const l=num($('b-length')?.value),w=num($('b-width')?.value),q=intv($('b-qty')?.value);
    if(client&&article){const p=entityPrice('client',client,article);if(p&&!$('b-pm2').value)$('b-pm2').value=p}
    if($('b-surface'))$('b-surface').textContent=sqm(surface(l,w,q));
    if($('b-total'))$('b-total').textContent=dh(surface(l,w,q)*num($('b-pm2')?.value));
  };
  ['b-client','b-article'].forEach(id=>$(id)?.addEventListener('change',buybackCalc));
  ['b-color','b-length','b-width','b-qty','b-pm2'].forEach(id=>$(id)?.addEventListener('input',buybackCalc));
  if($('b-date'))$('b-date').value=today();buybackCalc();
}
function bindInvCalculators(){
  const invCalc=()=>{const l=num($('i-length')?.value),w=num($('i-width')?.value),q=intv($('i-adjust')?.value);if($('i-surface'))$('i-surface').textContent=sqm(surface(l,w,Math.abs(q)))};
  ['i-article','i-color','i-length','i-width','i-adjust'].forEach(id=>$(id)?.addEventListener('input',invCalc));
  if($('i-date'))$('i-date').value=today();invCalc();
}
function bindAccountTools(){
  ['client','supplier'].forEach(type=>{
    const dateEl=$(type+'-pay-date');if(dateEl)dateEl.value=today();
    [type+'-pay-date',type+'-pay-days',type+'-pay-mode'].forEach(id=>$(id)?.addEventListener('input',()=>syncDue(type)));
    syncDue(type);
  });
}
function syncDue(type){
  const mode=$(type+'-pay-mode')?.value,date=$(type+'-pay-date')?.value,days=intv($(type+'-pay-days')?.value);
  if((mode==='LC'||mode==='Cheque')&&date){const d=new Date(date);d.setDate(d.getDate()+days);$(type+'-pay-due').value=d.toISOString().slice(0,10)}
  else if($(type+'-pay-due'))$(type+'-pay-due').value='';
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ PRINT ACCOUNT â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function togglePrintOptions(type){
  const el=document.getElementById(type+'-print-options');
  if(el)el.style.display=el.style.display==='none'?'block':'none';
}
function buildAccountReportHTML(type){
  const name=view[type+'Account'];
  if(!name)return '';
  const sum=accountSummary(type,name);
  const entity=(type==='client'?db.clients:db.suppliers).find(x=>x.name===name);
  const fromVal=$(type+'-print-from')?.value||'';
  const toVal=$(type+'-print-to')?.value||'';
  const hidePm2=$(type+'-print-hide-pm2')?.checked||false;
  const filteredOps=sum.ops.filter(x=>{if(!x.date)return true;if(fromVal&&x.date<fromVal)return false;if(toVal&&x.date>toVal)return false;return true});
  const filteredPay=sum.payments.filter(p=>{if(!p.date)return true;if(fromVal&&p.date<fromVal)return false;if(toVal&&p.date>toVal)return false;return true});
  const totalSalesFiltered=filteredOps.reduce((s,x)=>x.isBuyback?s:s+num(x.total),0);
  const totalBuybacksFiltered=filteredOps.reduce((s,x)=>x.isBuyback?s+num(x.total):s,0);
  const totalOpsFiltered=totalSalesFiltered-totalBuybacksFiltered;
  const totalPayFiltered=filteredPay.reduce((s,p)=>{if(p.deductNow===false)return p.paidStatus==='paid'?s+num(p.amount):s;return s+num(p.amount)},0);
  const periodLabel=fromVal||toVal?`${fromVal||'début'} -> ${toVal||'aujourd\'hui'}`:'Toutes les dates';
  const opsRows=filteredOps.map((x,i)=>{const dim=`${x.length||0} x ${x.width||0} cm`;const pm2=hidePm2?'':`<td>${dh(x.pm2)}/m2</td>`;return`<tr><td>${i+1}</td><td>${x.date}</td><td>${operationKind(x)}</td><td>${x.article}</td><td>${x.color||'-'}</td><td>${dim}</td><td>${siteName(x.site)}</td><td>${x.qty}</td><td>${sqm(surface(x.length,x.width,x.qty))}</td>${pm2}<td style="color:${x.isBuyback?'#dc2626':'inherit'}">${x.isBuyback?'-'+dh(x.total):dh(x.total)}</td></tr>`}).join('')||`<tr><td colspan="${hidePm2?9:10}" style="text-align:center;color:#9ca3af;padding:12px">Aucune opération sur cette période</td></tr>`;
  const payRows=filteredPay.map((p,i)=>`<tr><td>${i+1}</td><td>${p.date}</td><td>${dh(p.amount)}</td><td>${p.mode}</td><td>${p.due||'-'}</td><td>${paymentStatus(p)}</td><td>${p.note||'-'}</td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:12px">Aucun paiement sur cette période</td></tr>';
  const opsHead=hidePm2?'<th>#</th><th>Date</th><th>Article</th><th>Couleur</th><th>Dimensions</th><th>Site</th><th>Qté</th><th>Surface</th><th>Total</th>':'<th>#</th><th>Date</th><th>Article</th><th>Couleur</th><th>Dimensions</th><th>Site</th><th>Qté</th><th>Surface</th><th>Prix m2</th><th>Total</th>';
  const opsTotalColspan=hidePm2?9:10;
  const dateStr=new Date().toLocaleDateString('fr-MA',{day:'2-digit',month:'long',year:'numeric'});
  const timeStr=new Date().toLocaleTimeString('fr-MA');
  return {init:dh(sum.init),balance:dh(sum.balance),html:`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - ${periodLabel}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;padding:24px;color:#111;font-size:13px}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #1a56db}
.header-left h1{font-size:20px;font-weight:700;color:#1a56db;margin-bottom:2px}.header-left p{font-size:12px;color:#6b7280}
.header-right{text-align:right;font-size:11px;color:#6b7280;line-height:1.7}
.period-badge{display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}
.card{border:1px solid #e5e7eb;padding:12px;border-radius:10px;background:#f9fafb}
.card.green{border-color:#6ee7b7;background:#ecfdf5}.card.red{border-color:#fca5a5;background:#fef2f2}
.k{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;font-weight:600}.v{font-size:20px;font-weight:700;margin-top:5px}
h2{font-size:14px;font-weight:700;margin:20px 0 8px;display:flex;align-items:center;gap:8px}
h2 span{font-size:11px;font-weight:400;color:#6b7280}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{background:#f8fafc;padding:8px 10px;text-align:left;border:1px solid #e5e7eb;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280}
td{border:1px solid #e5e7eb;padding:7px 10px;font-size:12px;vertical-align:middle}
tfoot td{background:#f0fdf4;font-weight:700}tr:nth-child(even) td{background:#fafafa}
.footer{margin-top:24px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;text-align:center}
@media print{body{padding:12px}.cards{grid-template-columns:repeat(4,1fr)}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}.card{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="header"><div class="header-left"><h1>${type==='client'?'Compte client':'Compte fournisseur'} - ${name}</h1><p>Ville : ${entity?.city||'-'}</p><div class="period-badge">Periode : ${periodLabel}</div></div><div class="header-right">Imprime le ${dateStr}<br>a ${timeStr}<br>${hidePm2?'<span style="color:#d97706;font-weight:600">Prix m2 masque</span>':''}</div></div>
<div class="cards"><div class="card"><div class="k">Solde initial</div><div class="v">${dh(sum.init)}</div></div><div class="card"><div class="k">${type==='client'?'Total ventes':'Operations'}</div><div class="v">${dh(type==='client'?totalSalesFiltered:totalOpsFiltered)}</div></div>${type==='client'&&totalBuybacksFiltered>0?`<div class="card" style="border-color:#fca5a5"><div class="k">Total rachats</div><div class="v" style="color:#dc2626">-${dh(totalBuybacksFiltered)}</div></div>`:''}<div class="card"><div class="k">Paiements (periode)</div><div class="v">${dh(totalPayFiltered)}</div></div><div class="card ${sum.balance>0?'green':'red'}"><div class="k">Solde global restant</div><div class="v" style="color:${sum.balance>0?'#059669':'#dc2626'}">${dh(sum.balance)}</div></div></div>
<h2>Operations <span>(${filteredOps.length} ligne(s)${fromVal||toVal?' - periode filtree':''})</span></h2>
<table><thead><tr>${opsHead.replace('<th>Article</th>','<th>Type</th><th>Article/Frais</th>')}</tr></thead><tbody>${opsRows}</tbody><tfoot><tr><td colspan="${opsTotalColspan}"><strong>TOTAL OPERATIONS</strong></td><td><strong>${dh(totalOpsFiltered)}</strong></td></tr></tfoot></table>
<h2>Paiements <span>(${filteredPay.length} ligne(s)${fromVal||toVal?' - periode filtree':''})</span></h2>
<table><thead><tr><th>#</th><th>Date</th><th>Montant</th><th>Mode</th><th>Echeance</th><th>Statut</th><th>Remarque</th></tr></thead><tbody>${payRows}</tbody><tfoot><tr><td colspan="2"><strong>TOTAL PAIEMENTS</strong></td><td><strong>${dh(totalPayFiltered)}</strong></td><td colspan="4"></td></tr></tfoot></table>
<div class="footer">SayfoFlex - Document genere le ${dateStr} a ${timeStr} | Periode : ${periodLabel}</div>
</body></html>`,name,filteredOps,filteredPay,totalOpsFiltered,totalPayFiltered,fromVal,toVal,periodLabel,totalSalesFiltered,totalBuybacksFiltered};
}
function printAccount(type){
  const r=buildAccountReportHTML(type);if(!r.name)return alert('Veuillez sÃ©lectionner un '+(type==='client'?'client':'fournisseur'));
  const w=window.open('','_blank','width=1200,height=800');if(!w)return;
  w.document.write(r.html.replace('<\/script>','').replace('</body>','<script>window.onload=function(){window.print()}<\/script></body>'));
  w.document.close();
  document.getElementById(type+'-print-options').style.display='none';
}
async function shareAccountPDF(type){
  const r=buildAccountReportHTML(type);if(!r.name)return alert('Veuillez s\u00e9lectionner un '+(type==='client'?'client':'fournisseur'));
  if(typeof jspdf?.jsPDF==='undefined')return alert('Biblioth\u00e8que PDF non charg\u00e9e. Rafra\u00eechissez la page et r\u00e9essayez.');
  const name=r.name,sum=accountSummary(type,name),entity=(type==='client'?db.clients:db.suppliers).find(x=>x.name===name);
  try{
    const{doc,mm}=await buildJsPDF(type,name,entity,sum,r);
    const pdfBlob=doc.output('blob');
    const file=new File([pdfBlob],`Compte-${name}.pdf`,{type:'application/pdf'});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      await navigator.share({files:[file],title:`Compte ${name}`});
    }else{
      const url=URL.createObjectURL(pdfBlob);
      const a=document.createElement('a');a.href=url;a.download=`Compte-${name}.pdf`;a.click();
      URL.revokeObjectURL(url);
      notify('PDF t\u00e9l\u00e9charg\u00e9. Ouvrez WhatsApp pour le partager.');
    }
  }catch(e){
    notify('Erreur g\u00e9n\u00e9ration PDF: '+e.message,true);
    const txt='*Compte '+(type==='client'?'Client':'Fournisseur')+'* : '+name+'\n\n*Solde initial* : '+r.init+'\n*Total op\u00e9rations* : '+dh(r.totalOpsFiltered)+'\n*Total paiements* : '+dh(r.totalPayFiltered)+'\n*Solde restant* : '+dh(sum.balance)+'\n\n_Envoy\u00e9 depuis SayfoFlex ERP_';
    window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`,'_blank');
  }
  document.getElementById(type+'-print-options').style.display='none';
}
async function buildJsPDF(type,name,entity,sum,r){
  const {jsPDF}=jspdf;
  const doc=new jsPDF({unit:'mm',format:'a4'});
  const ml=20,w=170;
  const TX=(str,x,y,opt)=>doc.text(str,x,y,opt||{});
  const FC=(r,g,b)=>doc.setTextColor(r,g,b);
  const FN=()=>{if(typeof _camB!=='undefined'){try{doc.setFont('Cambria','bold');}catch(e){doc.setFont('times','bold');}}else doc.setFont('times','bold')};
  const FS=(sz)=>{doc.setFontSize(sz);FN()};
  const dateStr=new Date().toLocaleDateString('fr-MA',{day:'2-digit',month:'long',year:'numeric'});
  const dmy=s=>s?s.split('-').reverse().join('/'):'';
  const rangeStr=r.fromVal||r.toVal?'Du '+dmy(r.fromVal)+' au '+dmy(r.toVal):'Toutes les dates';
  window._camB=false;
  try{
    const res=await fetch('fonts/cambriab.ttf');
    const buf=await res.arrayBuffer();
    const bytes=new Uint8Array(buf);
    let bin='';for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
    doc.addFileToVFS('cambriab.ttf',btoa(bin));
    doc.addFont('cambriab.ttf','Cambria','bold');
    window._camB=true;
  }catch(e){}
  let y=20;
  doc.setFillColor(30,58,95);doc.rect(0,0,210,34,'F');
  FS(16);FC(255,255,255);TX('Nom Client : '+name,ml,20);
  FS(8);FC(200,215,240);TX('Ville : '+(entity?.city||'-'),ml,28);
  doc.setFillColor(59,130,246);doc.roundedRect(150,8,44,7,2,2,'F');
  FS(7);FC(255,255,255);TX('Relev\u00e9e de compte',163,13.5,{align:'center'});
  FS(7);FC(200,215,240);TX(rangeStr,190,22,{align:'right'});
  y=40;
  FS(16);FC(30,41,59);TX('SayfoFlex ERP',ml,y);
  FS(8);FC(100,116,139);TX(r.filteredOps.length+' op\u00e9rations, '+r.filteredPay.length+' paiements',190,y,{align:'right'});
  y+=7;
  FS(7);FC(100,116,139);TX('Application de gestion de l\u2019entreprise professionnel d\u00e9velopp\u00e9 par Sayfo Flex',ml,y);
  y+=8;
  const hasBuybacks=type==='client'&&r.totalBuybacksFiltered>0;
  const cards=[
    {bg:[239,246,255],lb:'Solde initial',val:r.init,vc:[29,78,216]},
    {bg:[245,243,255],lb:hasBuybacks?'Total ventes':'Op\u00e9rations (p\u00e9riode)',val:dh(hasBuybacks?r.totalSalesFiltered:r.totalOpsFiltered),vc:[124,58,237]},
    ...(hasBuybacks?[{bg:[254,242,242],lb:'Total rachats',val:'-'+dh(r.totalBuybacksFiltered),vc:[220,38,38]}]:[]),
    {bg:[255,247,237],lb:'Paiements (p\u00e9riode)',val:dh(r.totalPayFiltered),vc:[234,88,12]},
    {bg:sum.balance>0?[240,253,244]:[254,242,242],lb:'Solde restant',val:dh(sum.balance),vc:sum.balance>0?[22,163,74]:[220,38,38]}
  ];
  const cw=(w-12)/cards.length;
  cards.forEach((c,i)=>{
    const cx=ml+i*(cw+4)+1;
    doc.setFillColor(c.bg[0],c.bg[1],c.bg[2]);doc.roundedRect(cx,y,cw,18,2,2,'F');
    doc.setFillColor(c.vc[0],c.vc[1],c.vc[2]);doc.circle(cx+3.5,y+3,1.5,'F');
    FC(71,85,105);FS(7);TX(c.lb,cx+7,y+3.5);
    FC(c.vc[0],c.vc[1],c.vc[2]);FS(12);TX(c.val,cx+3,y+13);
  });
  y+=24;
  y+=4;FS(10);FC(30,41,59);TX('Op\u00e9rations ('+r.filteredOps.length+')',ml,y);y+=6;
  const opsHead=[{text:'#',colW:8},{text:'Date',colW:15},{text:'Type',colW:14},{text:'Article',colW:24},{text:'Couleur',colW:14},{text:'Dim.',colW:16},{text:'Site',colW:16},{text:'Qt\u00e9',colW:10},{text:'Surface',colW:14},{text:'Prix m2',colW:14},{text:'Total',colW:17}];
  const opsBody=r.filteredOps.map(x=>[String(r.filteredOps.indexOf(x)+1),x.date||'',operationKind(x),x.article||'',x.color||'-',(x.length||0)+'x'+(x.width||0),siteName(x.site),String(x.qty||0),sqm(surface(x.length,x.width,x.qty)),dh(x.pm2),x.isBuyback?'-'+dh(x.total):dh(x.total)]);
  opsBody.push([{content:'TOTAL OP\u00c9RATIONS',colSpan:10,styles:{halign:'left',fontStyle:'bold',fillColor:[241,245,249],textColor:[30,41,59]}},{content:dh(r.totalOpsFiltered),styles:{halign:'right',fontStyle:'bold',fillColor:[241,245,249],textColor:[30,41,59]}}]);
  FN();doc.autoTable({startY:y,head:[opsHead.map(h=>({content:h.text,styles:{fillColor:[30,41,59],textColor:[255,255,255],fontSize:7,fontStyle:'bold',halign:'center',cellPadding:1.5}}))],body:opsBody,theme:'plain',margin:{left:ml,right:ml},tableWidth:w,columnStyles:opsHead.reduce((a,h)=>(a[h.text]={cellWidth:h.colW,halign:'center'},a),{}),headStyles:{fillColor:[30,41,59],textColor:[255,255,255],fontSize:7,fontStyle:'bold'},bodyStyles:{fontSize:7,cellPadding:1.5},alternateRowStyles:{fillColor:[248,250,252]},didDrawPage:function(d){y=d.cursor.y}});
  y+=8;FS(10);FC(30,41,59);TX('Paiements ('+r.filteredPay.length+')',ml,y);y+=6;
  const payHead=[{text:'#',colW:8},{text:'Date',colW:18},{text:'Montant',colW:22},{text:'Mode',colW:18},{text:'\u00c9ch\u00e9ance',colW:20},{text:'Statut',colW:18},{text:'Remarque',colW:w-8-18-22-18-20-18}];
  const payBody=r.filteredPay.map(p=>[String(r.filteredPay.indexOf(p)+1),p.date||'',dh(p.amount),p.mode||'',p.due||'-',paymentStatus(p),p.note||'-']);
  payBody.push([{content:'TOTAL PAIEMENTS',colSpan:2,styles:{halign:'left',fontStyle:'bold',fillColor:[241,245,249],textColor:[30,41,59]}},{content:dh(r.totalPayFiltered),styles:{halign:'right',fontStyle:'bold',fillColor:[241,245,249],textColor:[30,41,59]}},'','','','']);
  FN();doc.autoTable({startY:y,head:[payHead.map(h=>({content:h.text,styles:{fillColor:[30,41,59],textColor:[255,255,255],fontSize:7,fontStyle:'bold',halign:'center',cellPadding:1.5}}))],body:payBody,theme:'plain',margin:{left:ml,right:ml},tableWidth:w,columnStyles:payHead.reduce((a,h)=>(a[h.text]={cellWidth:h.colW,halign:'center'},a),{}),headStyles:{fillColor:[30,41,59],textColor:[255,255,255],fontSize:7,fontStyle:'bold'},bodyStyles:{fontSize:7,cellPadding:1.5},alternateRowStyles:{fillColor:[248,250,252]},didDrawPage:function(d){y=d.cursor.y}});
  FS(6);FC(148,163,184);TX('SayfoFlex \u2014 Document g\u00e9n\u00e9r\u00e9 le '+dateStr,105,y+10,{align:'center'});
  return{doc,mm:doc.internal.pageSize};
}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ REFRESH â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function refresh(){
  normalizePayments();
  renderDatabase();
  renderMovements();
  renderInventoryImport();
  renderAccounts();
  enhanceFeeAndAuditUI();
  enhanceOperationTables();
  renderStock();
  // Analyse module removed from UI.
  // renderBenefice removed - module supprimé
  updateMetrics();
  sanitizeVisibleText();
  applyAccessMode();
}

// ===== SECURITE : force password change for default credentials =====
function showForcePasswordChange(user){
  forcePwUser=user;
  $('force-pw-input').value='';
  $('force-pw-confirm').value='';
  $('force-pw-modal').style.display='flex';
  setTimeout(()=>$('force-pw-input')?.focus(),50);
}
window.showForcePasswordChange=showForcePasswordChange;

$('force-pw-save')?.addEventListener('click',async()=>{
  if(!requireAdmin())return;
  const pw=($('force-pw-input')?.value||'').trim();
  const confirm=($('force-pw-confirm')?.value||'').trim();
  if(pw.length<8)return alert('Minimum 8 caracteres.');
  if(['1234','0000','admin','password','visiteur'].includes(pw.toLowerCase()))return alert('Mot de passe trop faible.');
  if(pw!==confirm)return alert('Les mots de passe ne correspondent pas.');
  const hash=await sha256(pw);
  const u=users.find(x=>x.id===forcePwUser?.id);
  if(!u)return alert('Erreur : utilisateur introuvable.');
  u.passwordHash=hash;
  forcePwUser.passwordHash=hash;
  save();refresh();
  $('force-pw-modal').style.display='none';
  notify('Mot de passe modifie. Securite renforcee.');
});
// ===== END SECURITE =====

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ STATIC EVENTS â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
function bindStaticEvents(){
  // Tab navigation
  document.addEventListener('click',e=>{
    if(e.target.matches('.tab-btn[data-main]')){
      document.body.classList.remove('home-mode');
      document.querySelectorAll('.tab-btn[data-main]').forEach(b=>b.classList.remove('active'));
      e.target.classList.add('active');
      document.querySelectorAll('.module').forEach(m=>m.classList.remove('active'));
      $('mod-'+e.target.dataset.main).classList.add('active');
    }
    const homeCard=e.target.closest('.home-card[data-home-main]');
    if(homeCard){
      const target=document.querySelector(`.tab-btn[data-main="${homeCard.dataset.homeMain}"]`);
      if(target)target.click();
      window.scrollTo({top:0,behavior:'smooth'});
    }
    if(e.target.matches('.sub-btn[data-panel]')){
      const wrap=e.target.closest('.module');
      wrap.querySelectorAll('.sub-btn').forEach(b=>b.classList.remove('active'));
      e.target.classList.add('active');
      wrap.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
      $(e.target.dataset.panel).classList.add('active');
    }
  });

  // Modals
  $('confirm-modal-ok').addEventListener('click',()=>{if(!requireAdmin())return;if(confirmCallback)confirmCallback();});
  $('confirm-modal-cancel').addEventListener('click',()=>{$('confirm-modal').style.display='none';});

  // Reset
  $('reset-app').addEventListener('click',()=>{
    if(!requireAdmin())return;
    if(confirm('Attention : supprimer TOUTES les donnees ? Cette action est irreversible.\n\nConseil : exportez une sauvegarde avant.'))
    {CKEYS.forEach(k=>db[k]=[]);sessionLines={purchase:[],sale:[],transfer:[],inventory:[],buyback:[]};edit={article:-1,client:-1,supplier:-1,site:-1,cp:-1,sp:-1};initDefaults();refresh();notify('Application reinitialisee');}
  });

  // KPI toggle
  $('toggle-dashboard').addEventListener('click',()=>{
    const d=$('dashboard-wrap');
    d.style.display=d.style.display==='none'?'grid':'none';
  });

  $('home-button')?.addEventListener('click',()=>{
    document.body.classList.add('home-mode');
    window.scrollTo({top:0,behavior:'smooth'});
  });

  // Restore modal
  $('btn-reset-stock-modal').addEventListener('click',()=>{openResetStockModal();});

  // Roles
  $('role-login')?.addEventListener('click',()=>{
    $('login-name-input').value='';
    $('admin-code-input').value='';
    $('role-modal').style.display='flex';
    setTimeout(()=>$('login-name-input')?.focus(),50);
  });
  $('role-logout')?.addEventListener('click',()=>{
    if(currentUser){const u=users.find(x=>x.id===currentUser.id);if(u)u.keepOnline=false;save()}
    localStorage.removeItem('gs3_user');sessionStorage.removeItem('gs3_user');setLoggedUser(null);notify('Deconnecte')
  });
  $('admin-code-cancel')?.addEventListener('click',()=>{if(currentUser)$('role-modal').style.display='none';});
  $('admin-code-ok')?.addEventListener('click',async()=>{
    const name=norm($('login-name-input').value).toLowerCase();
    const passwordHash=await sha256($('admin-code-input').value||'');
    const user=users.find(u=>u.name.toLowerCase()===name&&u.passwordHash===passwordHash);
    const remember=$('remember-me')?.checked||false;
    if(user){
      $('role-modal').style.display='none';
      setLoggedUser(user,remember);
      user.keepOnline=remember;
      save();
      if(DEFAULT_PASSWORD_HASHES.has(user.passwordHash)){
        showForcePasswordChange(user);
        return;
      }
      notify(`Connecte : ${user.name}`);
    }else{
      notify('Nom ou mot de passe incorrect',true);
    }
  });
  $('admin-code-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')$('admin-code-ok').click();});
  $('login-name-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')$('admin-code-ok').click();});

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(m=>{
    m.addEventListener('click',e=>{if(e.target===m&&!(m.id==='role-modal'&&!currentUser)&&m.id!=='force-pw-modal')m.style.display='none';});
  });

  // Keyboard shortcuts
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&$('force-pw-modal')?.style.display!=='flex'){document.querySelectorAll('.modal-overlay').forEach(m=>m.style.display='none');}
  });
}

function initDefaults(){
  if(!db.sites.length){
    db.sites.push({id:uid('site'),name:'Magasin Central',city:'Casablanca'},{id:uid('site'),name:'Point de Vente',city:'Rabat'});
  }
}

// Expose to global
window.saveArticle=saveArticle;window.saveClient=saveClient;window.saveSupplier=saveSupplier;window.saveSite=saveSite;
window.saveClientPrice=saveClientPrice;window.saveSupplierPrice=saveSupplierPrice;
window.savePurchase=savePurchase;window.saveSale=saveSale;window.saveBuyback=saveBuyback;window.saveTransfer=saveTransfer;window.saveInventory=saveInventory;
window.saveAccountPayment=saveAccountPayment;
window.editArticle=editArticle;window.editClientRow=editClientRow;window.editSupplierRow=editSupplierRow;window.editSiteRow=editSiteRow;
window.editClientPrice=editClientPrice;window.editSupplierPrice=editSupplierPrice;
window.removeRow=removeRow;window.removeSite=removeSite;window.clearForm=clearForm;window.clearFormMv=clearFormMv;window.clearFormInv=clearFormInv;
window.removeSessionLine=removeSessionLine;window.confirmSession=confirmSession;
window.setAccountView=setAccountView;window.printAccount=printAccount;window.togglePrintOptions=togglePrintOptions;
window.importExcelInventaire=importExcelInventaire;window.confirmExcelInventaire=confirmExcelInventaire;window.cancelExcelInventaire=cancelExcelInventaire;
window.exportBackup=exportBackup;window.openResetStockModal=openResetStockModal;window.applyResetStock=applyResetStock;
window.openEditLine=openEditLine;window.renderAnalytics=renderAnalytics;
window.renderBenefice=renderBenefice;
window.saveUser=saveUser;window.deleteUser=deleteUser;
window.saveSupabaseConfig=saveSupabaseConfig;window.manualSyncToSupabase=manualSyncToSupabase;window.loadFromSupabase=loadFromSupabase;
window.restoreFromHistory=restoreFromHistory;
window.editOperationRow=editOperationRow;window.deleteOperationRow=deleteOperationRow;
window.editPayment=editPayment;window.deletePayment=deletePayment;window.setPaymentPaidStatus=setPaymentPaidStatus;window.togglePaymentPaid=togglePaymentPaid;
window.promptClientFee=promptClientFee;window.createClientFee=createClientFee;

function adminWrap(fn){return function(...args){if(!requireAdmin())return;return fn.apply(this,args)}}
[
  'saveArticle','saveClient','saveSupplier','saveSite','saveClientPrice','saveSupplierPrice',
  'saveUser','deleteUser','saveSupabaseConfig','manualSyncToSupabase',
  'savePurchase','saveSale','saveBuyback','saveTransfer','saveInventory','saveAccountPayment',
  'editArticle','editClientRow','editSupplierRow','editSiteRow','editClientPrice','editSupplierPrice',
  'removeRow','removeSite','clearForm','clearFormMv','clearFormInv','removeSessionLine','confirmSession',
  'importExcelInventaire','confirmExcelInventaire','cancelExcelInventaire','openResetStockModal','applyResetStock','openEditLine','exportBackup',
  'restoreFromHistory','editOperationRow','deleteOperationRow','editPayment','deletePayment','setPaymentPaidStatus','togglePaymentPaid','promptClientFee','createClientFee'
].forEach(name=>{if(typeof window[name]==='function')window[name]=adminWrap(window[name]);});

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬ BENEFICE â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
let beneficePeriod=30;

// â"â‚¬â"â‚¬ Helper global cout m2
function coutPm2(article,length,width){
  const sp=db.supplierPrices.find(p=>p.article===article);
  if(sp)return num(sp.pm2);
  const achats=db.purchases.filter(p=>p.article===article&&num(p.length)===num(length)&&num(p.width)===num(width));
  if(achats.length)return achats.reduce((s,x)=>s+num(x.pm2),0)/achats.length;
  const all=db.purchases.filter(p=>p.article===article);
  if(!all.length)return 0;
  return all.reduce((s,x)=>s+num(x.pm2),0)/all.length;
}
function coutUnitaire(article,length,width){return coutPm2(article,length,width)*surface(length,width,1);}

function calcLignes(periodeJours){
  const ventes=db.sales.filter(s=>!s.isBuyback&&(!periodeJours||dateInPeriod(s.date,periodeJours)));
  return ventes.map(s=>{
    const pmA=coutPm2(s.article,s.length,s.width);
    const coutTotal=pmA*surface(s.length,s.width,intv(s.qty));
    const caTotal=num(s.total);
    const marge=caTotal-coutTotal;
    const txMarge=caTotal>0?((marge/caTotal)*100):0;
    const surf=surface(s.length,s.width,intv(s.qty));
    const pmV=surf>0?caTotal/surf:0;
    return{...s,pmA,pmV,coutTotal,caTotal,marge,txMarge,surf};
  });
}

function renderBenefice(){/* Module Bénéfice supprimé */}

// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
// IMPRESSION PDF COMPLET - PROFESSIONNEL
// â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬â"â‚¬
window.printBeneficeComplet=function(){
  const p=beneficePeriod;
  const periodLabel={7:'7 jours',30:'30 jours',90:'3 mois',180:'6 mois',365:'1 an',0:'Tout'};
  const periodName=periodLabel[p]||'Tout';
  const lignes=calcLignes(p);

  const totalCA=lignes.reduce((s,x)=>s+x.caTotal,0);
  const totalCout=lignes.reduce((s,x)=>s+x.coutTotal,0);
  const totalMarge=totalCA-totalCout;
  const tx=totalCA>0?((totalMarge/totalCA)*100).toFixed(1):0;

  // By article
  const byArt={};
  lignes.forEach(l=>{if(!byArt[l.article])byArt[l.article]={a:l.article,ca:0,cout:0,mg:0,qty:0,n:0,pvs:0,pas:0};byArt[l.article].ca+=l.caTotal;byArt[l.article].cout+=l.coutTotal;byArt[l.article].mg+=l.marge;byArt[l.article].qty+=intv(l.qty);byArt[l.article].n++;byArt[l.article].pvs+=l.pmV;byArt[l.article].pas+=l.pmA;});
  const artR=Object.values(byArt).sort((a,b)=>b.mg-a.mg);

  // By client
  const byCli={};
  lignes.forEach(l=>{if(!byCli[l.client])byCli[l.client]={c:l.client,ca:0,cout:0,mg:0,n:0};byCli[l.client].ca+=l.caTotal;byCli[l.client].cout+=l.coutTotal;byCli[l.client].mg+=l.marge;byCli[l.client].n++;});
  const cliR=Object.values(byCli).sort((a,b)=>b.mg-a.mg);

  // By month
  const byMo={};
  lignes.forEach(l=>{const m=l.date?l.date.slice(0,7):'??';if(!byMo[m])byMo[m]={m,ca:0,cout:0,mg:0,n:0};byMo[m].ca+=l.caTotal;byMo[m].cout+=l.coutTotal;byMo[m].mg+=l.marge;byMo[m].n++;});
  const moR=Object.values(byMo).sort((a,b)=>b.m.localeCompare(a.m));

  const fmt=v=>num(v).toLocaleString('fr-MA',{minimumFractionDigits:2,maximumFractionDigits:2})+' DH';
  const pct=(mg,ca)=>ca>0?((mg/ca)*100).toFixed(1)+'%':'-';
  const clr=mg=>mg>=0?'#059669':'#dc2626';

  const rowsDetail=lignes.map((r,i)=>{const t=r.caTotal>0?((r.marge/r.caTotal)*100).toFixed(1):0;return`<tr><td>${i+1}</td><td>${r.date}</td><td>${r.client}</td><td>${r.article}</td><td>${r.color||'-'}</td><td>${r.length||0}x${r.width||0}</td><td>${r.qty}</td><td>${fmt(r.pmV)}</td><td>${fmt(r.pmA)}</td><td>${fmt(r.pmV-r.pmA)}</td><td>${fmt(r.caTotal)}</td><td>${fmt(r.coutTotal)}</td><td style="color:${clr(r.marge)};font-weight:700">${fmt(r.marge)}</td><td>${t}%</td></tr>`}).join('');
  const rowsArt=artR.map((r,i)=>{const pv=r.n?r.pvs/r.n:0;const pa=r.n?r.pas/r.n:0;return`<tr><td>${i+1}</td><td>${r.a}</td><td>${r.qty}</td><td>${r.n}</td><td>${fmt(pv)}</td><td>${fmt(pa)}</td><td>${fmt(r.ca)}</td><td>${fmt(r.cout)}</td><td style="color:${clr(r.mg)};font-weight:700">${fmt(r.mg)}</td><td>${pct(r.mg,r.ca)}</td></tr>`}).join('');
  const rowsCli=cliR.map((r,i)=>`<tr><td>${i+1}</td><td>${r.c}</td><td>${r.n}</td><td>${fmt(r.ca)}</td><td>${fmt(r.cout)}</td><td style="color:${clr(r.mg)};font-weight:700">${fmt(r.mg)}</td><td>${pct(r.mg,r.ca)}</td><td>${r.mg>=0?'OK Rentable':'âÅ’ Perte'}</td></tr>`).join('');
  const rowsMo=moR.map(r=>`<tr><td>${r.m}</td><td>${r.n}</td><td>${fmt(r.ca)}</td><td>${fmt(r.cout)}</td><td style="color:${clr(r.mg)};font-weight:700">${fmt(r.mg)}</td><td>${pct(r.mg,r.ca)}</td></tr>`).join('');

  const w=window.open('','_blank','width=1300,height=900');if(!w)return;
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Rapport Benefice - GestStock ERP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;color:#111;background:#fff;padding:32px;font-size:13px}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #1a56db}
.header h1{font-size:24px;font-weight:700;color:#1a56db}
.header p{font-size:12px;color:#6b7280;margin-top:4px}
.meta{text-align:right;font-size:11px;color:#6b7280}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}
.kpi{border-radius:10px;padding:14px;color:#fff}
.kpi.green{background:linear-gradient(135deg,#059669,#047857)}
.kpi.red{background:linear-gradient(135deg,#dc2626,#b91c1c)}
.kpi.blue{background:linear-gradient(135deg,#1a56db,#7c3aed)}
.kpi.purple{background:linear-gradient(135deg,#7c3aed,#5b21b6)}
.kpi .k{font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.08em}
.kpi .v{font-size:22px;font-weight:700;margin-top:5px}
.bars{border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px}
.bar-row{margin-bottom:10px}
.bar-label{display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px}
.bar-track{background:#f3f4f6;border-radius:999px;height:8px;overflow:hidden}
.bar-fill{height:100%;border-radius:999px}
.interp{border-radius:8px;padding:14px;margin-bottom:20px;font-size:13px;line-height:1.7}
.section-title{font-size:15px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:12px}
th{background:#f8fafc;padding:8px 10px;text-align:left;border:1px solid #e5e7eb;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280}
td{border:1px solid #e5e7eb;padding:7px 10px;vertical-align:middle}
tfoot td{background:#f0fdf4;font-weight:700}
tr:nth-child(even) td{background:#fafafa}
.pos{color:#059669;font-weight:700}
.neg{color:#dc2626;font-weight:700}
.footer{margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center}
@media print{body{padding:16px}.kpis{grid-template-columns:repeat(4,1fr)}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}.kpi{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>

<div class="header">
  <div>
    <h1>Rapport Benefice - GestStock ERP V6</h1>
    <p>Analyse de rentabilite - Periode : <strong>${periodName}</strong></p>
  </div>
  <div class="meta">
    Genere le ${new Date().toLocaleDateString('fr-MA',{day:'2-digit',month:'long',year:'numeric'})}<br>
    ${lignes.length} transaction(s) analysee(s)
  </div>
</div>

<div class="kpis">
  <div class="kpi green"><div class="k">Chiffre d'affaires</div><div class="v">${fmt(totalCA)}</div></div>
  <div class="kpi red"><div class="k">Cout d'achat total</div><div class="v">${fmt(totalCout)}</div></div>
  <div class="kpi ${totalMarge>=0?'blue':'red'}"><div class="k">Bénéfice net</div><div class="v">${fmt(totalMarge)}</div></div>
  <div class="kpi purple"><div class="k">Taux de marge</div><div class="v">${tx}%</div></div>
</div>

<div class="bars">
  <div class="bar-row"><div class="bar-label"><span>Chiffre d'affaires</span><strong>${fmt(totalCA)}</strong></div><div class="bar-track"><div class="bar-fill" style="width:100%;background:linear-gradient(90deg,#059669,#34d399)"></div></div></div>
  <div class="bar-row"><div class="bar-label"><span>Coût d'achat</span><strong>${fmt(totalCout)}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${totalCA>0?Math.min(100,(totalCout/totalCA*100).toFixed(0)):0}%;background:linear-gradient(90deg,#dc2626,#f87171)"></div></div></div>
  <div class="bar-row"><div class="bar-label"><span>Bénéfice</span><strong style="color:${clr(totalMarge)}">${fmt(totalMarge)}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${totalCA>0?Math.min(100,Math.max(0,(totalMarge/totalCA*100).toFixed(0))):0}%;background:linear-gradient(90deg,#1a56db,#7c3aed)"></div></div></div>
</div>

<div class="interp" style="background:${num(tx)>=20?'#ecfdf5':num(tx)>=10?'#fffbeb':'#fef2f2'};border:1px solid ${num(tx)>=20?'#6ee7b7':num(tx)>=10?'#fde68a':'#fca5a5'}">
  <strong>${num(tx)>=20?'OK Bonne sante financiere':num(tx)>=10?'Attention Marge a ameliorer':'âÅ’ Marge insuffisante'}</strong><br>
  ${num(tx)>=20?`Votre taux de marge de ${tx}% est excellent. Bénéfice net de ${fmt(totalMarge)} sur un CA de ${fmt(totalCA)}.`:num(tx)>=10?`Taux de marge de ${tx}% correct mais améliorable. Négociez vos prix fournisseurs ou ajustez vos tarifs sur les articles à forte rotation.`:`Taux de marge de ${tx}% insuffisant. Vérifiez vos prix fournisseurs dans la base et revoyez votre politique tarifaire.`}
</div>

<!-- PAR ARTICLE -->
<div class="section-title">Benefice par Article</div>
<table>
  <thead><tr><th>#</th><th>Article</th><th>Qte</th><th>Ventes</th><th>Px vente/m2</th><th>Px achat/m2</th><th>CA</th><th>Cout</th><th>Benefice</th><th>Marge%</th></tr></thead>
  <tbody>${rowsArt||'<tr><td colspan="10" style="text-align:center;color:#9ca3af">Aucune donnee</td></tr>'}</tbody>
  <tfoot><tr><td colspan="6">TOTAL</td><td>${fmt(totalCA)}</td><td>${fmt(totalCout)}</td><td class="${totalMarge>=0?'pos':'neg'}">${fmt(totalMarge)}</td><td>${tx}%</td></tr></tfoot>
</table>

<!-- PAR CLIENT -->
<div class="section-title">Benefice par Client</div>
<table>
  <thead><tr><th>#</th><th>Client</th><th>Nb ventes</th><th>CA</th><th>Cout</th><th>Benefice</th><th>Marge%</th><th>Statut</th></tr></thead>
  <tbody>${rowsCli||'<tr><td colspan="8" style="text-align:center;color:#9ca3af">Aucune donnee</td></tr>'}</tbody>
  <tfoot><tr><td colspan="3">TOTAL</td><td>${fmt(totalCA)}</td><td>${fmt(totalCout)}</td><td class="${totalMarge>=0?'pos':'neg'}">${fmt(totalMarge)}</td><td>${tx}%</td><td></td></tr></tfoot>
</table>

<!-- PAR MOIS -->
<div class="section-title">Benefice par Mois</div>
<table>
  <thead><tr><th>Mois</th><th>Nb ventes</th><th>CA</th><th>Cout</th><th>Benefice</th><th>Marge%</th></tr></thead>
  <tbody>${rowsMo||'<tr><td colspan="6" style="text-align:center;color:#9ca3af">Aucune donnee</td></tr>'}</tbody>
  <tfoot><tr><td>TOTAL</td><td>${lignes.length}</td><td>${fmt(totalCA)}</td><td>${fmt(totalCout)}</td><td class="${totalMarge>=0?'pos':'neg'}">${fmt(totalMarge)}</td><td>${tx}%</td></tr></tfoot>
</table>

<!-- DETAIL LIGNE PAR LIGNE -->
<div class="section-title">Detail Ligne par Ligne</div>
<table>
  <thead><tr><th>#</th><th>Date</th><th>Client</th><th>Article</th><th>Couleur</th><th>Dim.</th><th>Qte</th><th>Px vente/m2</th><th>Px achat/m2</th><th>Ecart/m2</th><th>CA</th><th>Cout</th><th>Benefice</th><th>Marge%</th></tr></thead>
  <tbody>${rowsDetail||'<tr><td colspan="14" style="text-align:center;color:#9ca3af">Aucune donnee</td></tr>'}</tbody>
  <tfoot><tr><td colspan="10">TOTAL (${lignes.length} lignes)</td><td>${fmt(totalCA)}</td><td>${fmt(totalCout)}</td><td class="${totalMarge>=0?'pos':'neg'}">${fmt(totalMarge)}</td><td>${tx}%</td></tr></tfoot>
</table>

<div class="footer">GestStock ERP V6 - Rapport genere automatiquement le ${new Date().toLocaleDateString('fr-MA')} a ${new Date().toLocaleTimeString('fr-MA')}</div>
<script>window.onload=()=>window.print();<\/script>
</body></html>`);
  w.document.close();
};

// Alias ancien nom pour compatibilite
window.printBenefice=window.printBeneficeComplet;

function bindEffectAndDueModals(){
  // Effect modal buttons
  $('effect-deduct-now')?.addEventListener('click',()=>{
    if(!requireAdmin())return;
    if(!pendingPayment)return;
    doSavePayment({...pendingPayment,deductNow:true});
    pendingPayment=null;$('effect-modal').style.display='none';
  });
  $('effect-wait-due')?.addEventListener('click',()=>{
    if(!requireAdmin())return;
    if(!pendingPayment)return;
    doSavePayment({...pendingPayment,deductNow:false});
    pendingPayment=null;$('effect-modal').style.display='none';
  });
  $('effect-cancel')?.addEventListener('click',()=>{pendingPayment=null;$('effect-modal').style.display='none';});

  // Due modal buttons
  let currentDuePaymentId=null;
  $('due-modal-paid')?.addEventListener('click',()=>{
    if(!requireAdmin())return;
    if(currentDuePaymentId){const p=db.payments.find(x=>x.id===currentDuePaymentId);if(p){p.paidStatus='paid';save();refresh();}}
    $('due-modal').style.display='none';checkDuePayments();
  });
  $('due-modal-unpaid')?.addEventListener('click',()=>{
    if(!requireAdmin())return;
    if(currentDuePaymentId){const p=db.payments.find(x=>x.id===currentDuePaymentId);if(p){p.paidStatus='unpaid';save();refresh();}}
    $('due-modal').style.display='none';checkDuePayments();
  });
  $('due-modal-later')?.addEventListener('click',()=>{$('due-modal').style.display='none';});

  // Check due payments on load
  function checkDuePayments(){
    const today_=new Date();today_.setHours(0,0,0,0);
    // Find payments with due date today or passed, deductNow=false, no paidStatus yet
    const due=db.payments.filter(p=>{
      if(p.deductNow!==false)return false;
      if(p.paidStatus)return false; // already answered
      if(!p.due)return false;
      const d=new Date(p.due);d.setHours(0,0,0,0);
      return d<=today_;
    });
    if(!due.length)return;
    const p=due[0];
    currentDuePaymentId=p.id;
    const entity=p.type==='client'?'Client':'Fournisseur';
    $('due-modal-desc').textContent=`Un paiement de ${p.name} est arrive a echeance.`;
    $('due-modal-detail').innerHTML=`
      <strong>${entity} :</strong> ${p.name}<br>
      <strong>Montant :</strong> ${dh(p.amount)}<br>
      <strong>Mode :</strong> ${p.mode}<br>
      <strong>Date effet :</strong> ${p.date}<br>
      <strong>Echeance :</strong> ${p.due}<br>
      <strong>Remarque :</strong> ${p.note||'-'}`;
    setTimeout(()=>$('due-modal').style.display='flex',800);
  }
  window._checkDuePayments=checkDuePayments;
  setTimeout(checkDuePayments,1200);
}


bindStaticEvents();
bindEffectAndDueModals();
startSanitizeObserver();
load();
isApplyingRemote=true;
initDefaults();
refresh();
isApplyingRemote=false;
initSupabase();
idbTryLoad();
(supabaseClient?loadFromSupabase(true):Promise.resolve()).then(()=>{
  if(supabaseClient)subscribeSupabaseRealtime();
  if(!currentUser){
    const keepUser=supabaseClient&&users.find(u=>u.keepOnline);
    if(keepUser){
      setLoggedUser(keepUser);
      notify(`Connecte automatiquement : ${keepUser.name}`);
    }else{
      $('role-modal').style.display='flex';
      setTimeout(()=>$('login-name-input')?.focus(),80);
    }
  }
});
