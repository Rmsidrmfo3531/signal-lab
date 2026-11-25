// Safe, optional HTTPS release updater. It never touches user data (.env/store.json).
// Updates are verified, staged while running and applied only before a later server start.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const MAX_MANIFEST_BYTES = 131072;
export const MAX_FILE_BYTES = 2_000_000;
export const MAX_UPDATE_BYTES = 20_000_000;
const ALLOWED_ROOTS = new Set([
 // The staged copy is self-tested before installation, so every module the server
 // imports and every script a test executes must be listed (tests/update_bundle.test.mjs).
 'live_clients.mjs','live_orders.mjs','live_executor.mjs','live_overview.mjs','git_update.mjs','live_readiness.mjs','news_article.mjs','live_review.mjs','link_check.mjs','reports_push.mjs','live_telegram.mjs','scalp_reversal.mjs','dca_plan.mjs','backtest.mjs','portfolio_sim.mjs','trade_horizon.mjs','copy_executor.mjs','bingx_position_mode.mjs','copy_parser.mjs','copy_telegram.mjs','scalp_executor.mjs','scalp_telegram.mjs','scalp_journal.mjs','venue_execution.mjs','venue_service.mjs','gateio_market.mjs','bingx_market.mjs','venue_market_data.mjs','decimal_grid.mjs','request_guard.mjs','diagnose_scan.mjs','diagnose_scan.bat',
 'scripts/run-node-tests.mjs','public_read_budget.mjs','indicators.mjs','binance_execution.mjs','volume_profile.mjs','volume_targets.mjs',
 'profile_collector.mjs','telegram_watch.mjs','telegram_final.mjs','telegram_transport.mjs','news_translation.mjs','market_commentary.mjs','strategy_validation.mjs',
 'scripts/compare-issue6-strategies.mjs','research/legacy_v58/engine.mjs','research/legacy_v58/quality.mjs','server.mjs','engine.mjs','quality.mjs',
 'signal_pipeline.mjs','observation.mjs','scan_diagnostics.mjs','signal_policy.mjs','research/legacy_v58/decision.mjs','markets.mjs','news.mjs',
 'links.mjs','journal.mjs','signal_lifecycle.mjs','paper.mjs','paper_health.mjs','mobile_access.mjs','windows_paper_notify.mjs',
 'windows_paper_notify.ps1','updater.mjs','update-cli.mjs','package.json','start.sh',
 'persistence.mjs','data-cli.mjs','start.bat','start_mobile.bat','start_auto.bat','start_auto_test.bat','enable_auto_update.bat',
 'disable_auto_update.bat','windows-supervisor.mjs','windows-update-source.mjs','backup_data.bat','migrate_legacy_data.bat','restore_data.bat',
 'open_data_folder.bat','scripts/check-market-data.mjs','scripts/check-news.mjs','scripts/check-venue-market-data.mjs','scripts/backtest.mjs','backtest.bat','venue_overlap.bat','start_shared.bat','scripts/venue-overlap.mjs','paper_telegram.mjs','windows_keep_awake.mjs','windows_keep_awake.ps1','research/candidates.mjs','research/trader_entries.mjs','research/follow_scan.mjs','exchange_pnl.mjs','venue_positions.mjs','manual_ledger.mjs','daily_pnl.mjs','testnet_budget.mjs','testnet_history_reset.mjs','research/data/trader_entries.json','pattern_detectors.mjs','score_factors.mjs','venue_charts.mjs','copy_controls.mjs','account_alerts.mjs','copy_analytics.mjs','scalp_simulator.mjs','scalp_wyckoff.mjs','scalp_vsa.mjs','scalp_ai_lens.mjs','real_manual_trade.mjs','real_safety.mjs','real_trailing.mjs','maker_order.mjs','orderflow.mjs','firechart.mjs','whale_cvd.mjs','whale_zones.mjs','pump_alert.mjs','pump_fade.mjs','ready_check.mjs','real_margin_alert.mjs','copy_listener_health.mjs','scalp_ladder.mjs','research/trader_style.mjs'
]);
const VERSION=/^\d+\.\d+\.\d+$/;
export function compareVersions(a,b){
 if(!VERSION.test(a)||!VERSION.test(b))throw Error('잘못된 버전 형식');
 const x=a.split('.').map(Number),y=b.split('.').map(Number);
 for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i]?1:-1}return 0;
}
export function allowedFile(name){
 if(typeof name!=='string'||name.length>180||name.includes('\\')||name.includes('..')||name.startsWith('/')||name.includes('\0'))return false;
 if(!/^[A-Za-z0-9_.\-/]+$/.test(name))return false;
 if(ALLOWED_ROOTS.has(name))return true;
 return /^(?:public|tests)\/[A-Za-z0-9_.\-/]+\.(?:mjs|js|css|html|json|svg|ico)$/.test(name);
}
function sha(buffer){return createHash('sha256').update(buffer).digest('hex')}
export function validateManifest(manifest,manifestURL){
 const origin=new URL(manifestURL);
 if(origin.protocol!=='https:')throw Error('업데이트 주소는 HTTPS만 지원합니다');
 if(!manifest||typeof manifest!=='object'||!VERSION.test(manifest.version)||!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>150)throw Error('업데이트 목록 형식 오류');
 const names=new Set();
 const files=manifest.files.map(f=>{
  if(!allowedFile(f.path)||names.has(f.path)||typeof f.sha256!=='string'||!/^[0-9a-f]{64}$/i.test(f.sha256))throw Error('안전하지 않은 업데이트 파일 지정: '+String(f?.path));
  if(typeof f.url!=='string'||f.url.length>1024)throw Error('업데이트 파일 URL 오류');
  const absolute=new URL(f.url,origin);
  if(absolute.protocol!=='https:'||absolute.origin!==origin.origin||absolute.username||absolute.password)throw Error('배포 URL은 같은 HTTPS 출처여야 합니다');
  names.add(f.path);return {path:f.path,url:absolute.href,sha256:f.sha256.toLowerCase()};
 });
 return {version:manifest.version,files};
}
async function fetchLimited(url,maxBytes,{fetcher=fetch}={}){
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),15000);
 try{
  const r=await fetcher(url,{signal:ctrl.signal,redirect:'error',headers:{Accept:'application/json,application/octet-stream'}});
  if(!r.ok)throw Error('업데이트 서버 응답 오류: HTTP '+r.status);
  const length=Number(r.headers?.get?.('content-length')||0);
  if(length>maxBytes)throw Error('업데이트 파일 크기 제한 초과');
  // Stream to enforce size limit even when Content-Length is absent.
  const chunks=[];let size=0;
  for await(const chunk of r.body){size+=chunk.byteLength;if(size>maxBytes)throw Error('업데이트 파일 크기 제한 초과');chunks.push(Buffer.from(chunk))}
  return Buffer.concat(chunks);
 } finally{clearTimeout(timer)}
}
function safeTarget(root,file){
 if(!allowedFile(file))throw Error('허용되지 않는 파일 경로');
 const rootAbs=path.resolve(root),target=path.resolve(root,file);
 if(!target.startsWith(rootAbs+path.sep))throw Error('잘못된 파일 경로');
 let p=path.dirname(target);
 while(p.startsWith(rootAbs)&&p!==rootAbs){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('심볼릭 링크 디렉터리는 업데이트할 수 없습니다');p=path.dirname(p)}
 if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('심볼릭 링크 파일은 업데이트할 수 없습니다');
 return target;
}
export function pendingInfo(root){
 const f=path.join(root,'.updates','pending','manifest.json');
 try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return null}
}
export async function stageUpdate({root,manifestURL,currentVersion,fetcher=fetch}){
 if(typeof manifestURL!=='string'||!manifestURL.trim())return {state:'unconfigured',message:'UPDATE_MANIFEST_URL 미설정'};
 if(new URL(manifestURL).protocol!=='https:')throw Error('업데이트 주소는 HTTPS만 지원합니다');
 const content=await fetchLimited(manifestURL,MAX_MANIFEST_BYTES,{fetcher});
 const manifest=validateManifest(JSON.parse(content.toString('utf8')),manifestURL);
 if(compareVersions(manifest.version,currentVersion)<=0)return {state:'current',version:currentVersion};
 const stageRoot=path.join(root,'.updates','staging-'+process.pid+'-'+Date.now());
 const pending=path.join(root,'.updates','pending');
 if(fs.existsSync(pending)){
  const old=pendingInfo(root);
  if(old?.version===manifest.version)return {state:'staged',version:old.version};
 }
 let total=0;
 try{
  fs.mkdirSync(stageRoot,{recursive:true});
  for(const f of manifest.files){
   const dest=safeTarget(stageRoot,f.path);
   safeTarget(root,f.path); // validate target before downloading
   const bytes=await fetchLimited(f.url,MAX_FILE_BYTES,{fetcher});
   total+=bytes.length;if(total>MAX_UPDATE_BYTES)throw Error('전체 업데이트 크기 제한 초과');
   if(sha(bytes)!==f.sha256)throw Error('다운로드 파일 SHA-256 불일치: '+f.path);
   fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes,{flag:'wx'});
  }
  fs.writeFileSync(path.join(stageRoot,'manifest.json'),JSON.stringify({version:manifest.version,files:manifest.files.map(({path,sha256})=>({path,sha256}))},null,2));
  if(fs.existsSync(pending))fs.rmSync(pending,{recursive:true,force:true});
  fs.renameSync(stageRoot,pending);
  return {state:'staged',version:manifest.version,fileCount:manifest.files.length};
 }catch(e){fs.rmSync(stageRoot,{recursive:true,force:true});throw e}
}
export function applyPending({root,currentVersion}){
 const metadata=pendingInfo(root);
 if(!metadata)return {state:'none'};
 if(!VERSION.test(metadata.version)||!Array.isArray(metadata.files)||metadata.files.length<1)throw Error('대기 중인 업데이트 메타데이터 오류');
 if(compareVersions(metadata.version,currentVersion)<=0){fs.rmSync(path.join(root,'.updates','pending'),{recursive:true,force:true});return {state:'obsolete'}}
 const stage=path.join(root,'.updates','pending');
 for(const f of metadata.files){
  if(!allowedFile(f.path)||!/^[0-9a-f]{64}$/i.test(f.sha256))throw Error('업데이트 항목 검증 실패');
  const staged=safeTarget(stage,f.path);safeTarget(root,f.path);
  if(!fs.existsSync(staged)||sha(fs.readFileSync(staged))!==f.sha256.toLowerCase())throw Error('대기 중인 업데이트 파일 무결성 오류: '+f.path);
 }
 const backup=path.join(root,'.updates','backup-'+Date.now());
 const changed=[];
 try{
  for(const f of metadata.files){
   const target=safeTarget(root,f.path),source=safeTarget(stage,f.path),backupFile=path.join(backup,f.path);
   const existed=fs.existsSync(target);
   if(existed){fs.mkdirSync(path.dirname(backupFile),{recursive:true});fs.copyFileSync(target,backupFile)}
   changed.push({path:f.path,existed});
   fs.mkdirSync(path.dirname(target),{recursive:true});
   const temp=target+'.update-'+process.pid;
   fs.copyFileSync(source,temp);fs.renameSync(temp,target);
  }
  fs.rmSync(stage,{recursive:true,force:true});
  return {state:'applied',version:metadata.version,backup};
 }catch(e){
  for(const f of changed.reverse()){
   const target=safeTarget(root,f.path),saved=path.join(backup,f.path);
   try{if(f.existed&&fs.existsSync(saved))fs.copyFileSync(saved,target);else if(!f.existed)fs.rmSync(target,{force:true})}catch{}
  }
  throw new Error('업데이트 실패, 백업에서 복구 시도: '+e.message);
 }
}
