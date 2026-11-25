// Shared countdown banner formatter for scheduled GitHub auto-updates (browser & Node tests).
const kstClock=t=>{
 const n=Number(t);
 if(!Number.isFinite(n)||n<=0)return '';
 return new Date(n).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
};

export function formatUpdateSchedule(scheduled,now=Date.now()){
 if(!scheduled||!Number.isFinite(Number(scheduled.scheduledAt)))return null;
 const scheduledAt=Number(scheduled.scheduledAt);
 const remMs=scheduledAt-Number(now);
 let title;
 if(scheduled.waitingIdle){
  title='업데이트가 확인되어 진행 중인 작업이 끝나면 곧 업데이트 진행 예정입니다.';
 }else if(remMs>=60000){
  const mins=Math.floor(remMs/60000);
  const secs=Math.floor((remMs%60000)/1000);
  const when=secs>0?`${mins}분 ${String(secs).padStart(2,'0')}초`:`${mins}분`;
  title=`업데이트가 확인되어 ${when} 뒤에 업데이트 진행 예정입니다.`;
 }else if(remMs>0){
  const secs=Math.max(1,Math.ceil(remMs/1000));
  title=`업데이트가 확인되어 ${secs}초 뒤에 업데이트 진행 예정입니다.`;
 }else{
  title='업데이트가 확인되어 곧 업데이트 진행 예정입니다.';
 }
 const at=kstClock(scheduledAt);
 const detail=[
  scheduled.latestDisplayVersion?`새 버전 ${scheduled.latestDisplayVersion}`:'',
  Number(scheduled.changesCount)>0?`변경 ${Number(scheduled.changesCount)}건`:'',
  at?`예정 시각 ${at} KST`:'',
 ].filter(Boolean).join(' · ');
 return {title,detail,remMs};
}
