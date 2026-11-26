(() => {
  'use strict';
  const NAV_OFFSET = 40;
  const POLL_MS = 2000;
  const SECTION_IDS = ['home', 'about', 'monitoring', 'how', 'history', 'faq'];
  const $ = id => document.getElementById(id);
  let isAdmin = false;
  let controlEnabled = true;
  let sending = false;
  let pendingCommand = null;
  let currentMode = 'AUTO';
  let modeBusy = false;
  let historyRecords = [];
  let historyPage = 1;
  const HISTORY_PAGE_SIZE = 50;

  function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
  function setState(id, state) { const el = $(id); if (el) el.dataset.state = state; }
  function num(v) { if (v === null || v === undefined || v === '') return NaN; return Number(v); }
  function fmt(v, d) { const n = num(v); return Number.isFinite(n) ? n.toFixed(d) : '--'; }
  function fmtUptime(v) {
    const n = num(v); if (!Number.isFinite(n) || n < 0) return '--';
    const d=Math.floor(n/86400),h=Math.floor(n%86400/3600),m=Math.floor(n%3600/60),s=Math.floor(n%60);
    const p=x=>String(x).padStart(2,'0'); return (d?d+'d ':'')+p(h)+':'+p(m)+':'+p(s);
  }
  function reasonText(code) {
    const labels={overtemp:'over-temperature',overcurrent:'overcurrent',overvoltage:'over-voltage',undervoltage:'under-voltage'};
    return code ? (labels[code] || String(code).replace(/_/g,' ')) : '';
  }

  // Navigation only includes the sections available in the current login state.
  function visibleSections() {
    return SECTION_IDS.filter(id => { const el=$(id); return el && !el.hidden; });
  }
  function setActive(id) {
    document.querySelectorAll('.nav-link[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===id));
  }
  function navigate(id) {
    const target=$(id); if(!target || target.hidden) return;
    const top=target.getBoundingClientRect().top+window.scrollY-NAV_OFFSET;
    window.scrollTo({top,behavior:'smooth'}); history.replaceState(null,'','#'+id); setActive(id);
  }
  document.querySelectorAll('.nav-link[data-page]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();navigate(a.dataset.page);}));
  const scrollObserver = new IntersectionObserver(entries=>entries.forEach(entry=>{
    if(entry.isIntersecting && !entry.target.hidden) setActive(entry.target.id);
  }),{rootMargin:'-45% 0px -50% 0px',threshold:0});
  SECTION_IDS.forEach(id=>{const el=$(id);if(el)scrollObserver.observe(el);});

  function renderStatus(data) {
    const reason=reasonText(data.trip_reason); let state='unknown',label='Not reported',note='The device is online but has not reported a protection status yet.';
    if(data.system_status==='normal'){state='normal';label='Normal';note='All readings are within safe limits.';}
    else if(data.system_status==='warning'){state='warning';label='Warning';note=reason?'Warning: '+reason+'. Readings are approaching unsafe limits.':'Readings are approaching unsafe limits.';}
    else if(data.system_status==='critical'){state='critical';label='Critical';note=reason?'Unsafe condition: '+reason+'.':'An unsafe condition was detected.';if(data.relay==='off')note+=' The outlet was disconnected.';}
    setState('status-panel',state);setText('system-status',label);setText('status-note',note);
  }
  function setControlMessage(message){setText('control-msg',message||'');}
  function renderOutlet(data) {
    const state=data.relay==='on'?'on':data.relay==='off'?'off':'unknown';let label=state==='on'?'ON':state==='off'?'OFF':'--';
    const cid=num(data.command_id),ack=num(data.ack_id);
    if(Number.isFinite(cid)&&Number.isFinite(ack)&&cid>ack&&data.relay_command)label+=' · switching to '+String(data.relay_command).toUpperCase()+'…';
    setState('outlet-panel',state);setText('outlet-status',label);
    if(pendingCommand&&Number.isFinite(ack)&&ack>=pendingCommand.id){
      setControlMessage(data.relay===pendingCommand.state?'Done: the outlet is '+pendingCommand.state.toUpperCase()+'.':'The device did not switch the outlet. Check the system status above.');pendingCommand=null;
    }
  }
  const SENSOR_BITS = {voltage:2,current:4,temperature:8};
  let sensorMask = 14;
  let sensorBusy = false;
  function sensorEnabled(name, mask=sensorMask){return (mask & SENSOR_BITS[name]) !== 0;}
  function sensorValue(value, enabled, digits, valid=true){
    if(!enabled)return 'offline';
    if(!valid || value===null || value===undefined || value==='')return '0';
    return fmt(value,digits);
  }
  function updateSensorControls(mask){
    if(Number.isFinite(num(mask)))sensorMask=Number(mask)&14;
    document.querySelectorAll('[data-sensor-toggle]').forEach(button=>{
      const enabled=sensorEnabled(button.dataset.sensorToggle);
      button.textContent=enabled?'ON':'OFF';button.setAttribute('aria-pressed',enabled?'true':'false');
      button.disabled=!isAdmin || currentMode!=='MAINTENANCE' || sensorBusy;
    });
    const panel=$('sensor-control-panel');
    if(panel)panel.hidden=(currentMode!=='MAINTENANCE');
    const note=$('sensor-control-note');
    if(note)note.textContent=!isAdmin?'Admin login required.':currentMode!=='MAINTENANCE'?'Switch to MAINTENANCE to change sensor states.':'Sensor controls are ready.';
  }
  function updateMonitoring(data) {
    const mask=Number.isFinite(num(data.test_mask))?Number(data.test_mask):sensorMask;
    updateSensorControls(mask);
    const vOn=sensorEnabled('voltage',mask),iOn=sensorEnabled('current',mask),tOn=sensorEnabled('temperature',mask);
    setText('voltage',sensorValue(data.voltage,vOn,1));
    setText('current',sensorValue(data.current,iOn,2));
    setText('temperature',sensorValue(data.temperature,tOn,1,data.temperature_valid!==false));
    let power=num(data.power);
    if(!Number.isFinite(power)&&vOn&&iOn){const v=num(data.voltage),i=num(data.current);power=(Number.isFinite(v)?v:0)*(Number.isFinite(i)?i:0);}
    setText('power',vOn&&iOn?(Number.isFinite(power)?power.toFixed(0):'0'):'offline');
    setText('uptime',fmtUptime(data.uptime_s));setText('link-state','Online');
    const age=num(data.age_seconds);setText('link-age',Number.isFinite(age)?Math.round(age)+' s ago':'');
    renderStatus(data);renderOutlet(data);
    if(data.device_mode==='SLEEP' || data.device_mode==='AUTO' || data.device_mode==='MAINTENANCE'){
      if(data.device_mode!==currentMode && data.device_mode==='SLEEP') setText('mode-message','Device reported that it entered sleep mode.');
    }
  }
  function showOffline(data, unreachable) {
    ['voltage','current','temperature','power'].forEach(id=>setText(id,'offline'));
    setText('uptime','--');
    const age=data?num(data.age_seconds):NaN;setText('link-state','Offline');setText('link-age',Number.isFinite(age)?'last seen '+Math.round(age)+' s ago':'');
    setState('status-panel','offline');setText('system-status','Device offline');
    setText('status-note',unreachable?'Cannot reach the server.':'No recent data from the device. Check its power and Wi-Fi.');
    setState('outlet-panel','unknown');setText('outlet-status','--');
  }
  async function getSensorData(){
    try{const r=await fetch('/api/readings',{cache:'no-store'});const d=await r.json().catch(()=>null);if(!r.ok||!d||!d.online){showOffline(d,false);return;}updateMonitoring(d);}
    catch(e){console.error('Unable to retrieve sensor data:',e);showOffline(null,true);}
  }

  const modeLabel=m=>m||'';
  // Outlet ON/OFF buttons are only available to an admin in MAINTENANCE mode.
  function applyControlVisibility(){
    const manual=currentMode==='MAINTENANCE';
    $('control-buttons').hidden=!(isAdmin&&manual);
    $('control-locked').hidden=!(!isAdmin||!manual);
    if(isAdmin&&!manual){setText('control-locked-text','Outlet control is available in MAINTENANCE mode only. Switch the Operating Mode above to MAINTENANCE.');$('control-login-btn').hidden=true;}
    else if(!isAdmin){setText('control-locked-text',controlEnabled?'Log in as admin to switch the outlet.':'Outlet control is disabled until an admin password is configured.');$('control-login-btn').hidden=!controlEnabled;}
  }
  function updateModeUi(mode, message=''){
    currentMode=mode;
    const badge=$('mode-current');if(badge){badge.textContent=modeLabel(mode);badge.dataset.mode=mode;}
    document.querySelectorAll('[data-mode-button]').forEach(b=>{b.classList.toggle('active',b.dataset.modeButton===mode);b.disabled=modeBusy;});
    const descriptions={AUTO:'Automatic monitoring is active. Live readings update as data arrives, and sensor readings are saved to the database every 3 minutes.',MAINTENANCE:'Live voltage, current, and temperature readings continue updating. Automatic history logging is paused, and the admin can manually switch the outlet ON or OFF.',SLEEP:'Sleep mode has been requested. The ESP-01S must remain awake to receive commands while the Arduino enters low-power sleep.'};
    setText('mode-description',descriptions[mode]||descriptions.AUTO);
    setText('mode-message',message);
    const wakeActions=$('maintenance-actions');
    if(wakeActions) wakeActions.hidden=!(isAdmin && mode==='SLEEP');
    applyControlVisibility();
    updateSensorControls(sensorMask);
  }
  async function setMode(mode){
    if(!isAdmin||modeBusy)return;
    if(!['AUTO','MAINTENANCE','SLEEP'].includes(mode))return;
    if(mode==='SLEEP'&&!window.confirm('Request SLEEP mode? The Arduino will stop sending live readings when the firmware supports this command.'))return;
    modeBusy=true;updateModeUi(currentMode,'Sending '+modeLabel(mode)+' mode command…');
    try{
      const r=await fetch('/api/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});
      const d=await r.json().catch(()=>({}));
      if(r.status===401){isAdmin=false;updateAuthUi();openLogin();return;}
      if(!r.ok)throw new Error(d.error||'HTTP '+r.status);
      updateModeUi(mode,mode==='SLEEP'?'Sleep command queued. Waiting for the device to confirm sleep.':modeLabel(mode)+' mode command queued.');
      await loadHistory();
    }catch(e){updateModeUi(currentMode,'Could not change mode: '+e.message);}
    finally{modeBusy=false;document.querySelectorAll('[data-mode-button]').forEach(b=>b.disabled=false);}
  }
  document.querySelectorAll('[data-mode-button]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.modeButton)));
  $('wake-up-btn').addEventListener('click',async()=>{
    if(!isAdmin||modeBusy||currentMode!=='SLEEP')return;
    if(!window.confirm('Wake the device and return it to MAINTENANCE mode?'))return;
    await setMode('MAINTENANCE');
    if(currentMode==='MAINTENANCE') setText('mode-message','Wake-up command queued. Waiting for the device to confirm that it is awake.');
  });

  function updateAuthUi(){
    const btn=$('auth-btn');btn.dataset.admin=isAdmin?'true':'false';setText('auth-label',isAdmin?'Log Out':'Admin Log In');
    document.querySelectorAll('[data-public-nav]').forEach(el=>el.hidden=isAdmin);
    document.querySelectorAll('[data-admin-nav]').forEach(el=>el.hidden=!isAdmin);
    document.querySelectorAll('[data-public-section]').forEach(el=>el.hidden=isAdmin);
    document.querySelectorAll('[data-admin-section]').forEach(el=>el.hidden=!isAdmin);
    applyControlVisibility();
    if(isAdmin){updateModeUi(currentMode);loadHistory();navigate('monitoring');}else{navigate('home');}
  }
  async function loadSession(){try{const r=await fetch('/api/session',{cache:'no-store'});const s=await r.json();isAdmin=!!s.admin;controlEnabled=s.control_enabled!==false;currentMode=s.mode||'AUTO';if(Number.isFinite(num(s.test_mask)))sensorMask=Number(s.test_mask)&14;}catch(e){isAdmin=false;}updateAuthUi();}
  function openLogin(){const dialog=$('login-dialog');setText('login-error','');$('login-password').value='';if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}else dialog.setAttribute('open','');$('login-password').focus();}
  function resetPwView(){const i=$('login-password');if(i&&i.type==='text')$('pw-toggle').click();}
  function closeLogin(){resetPwView();const d=$('login-dialog');if(typeof d.close==='function'){if(d.open)d.close();}else d.removeAttribute('open');}
  async function submitLogin(e){e.preventDefault();setText('login-error','');try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('login-password').value})});if(r.ok){closeLogin();$('login-password').value='';await loadSession();setControlMessage('Logged in.');}else if(r.status===429)setText('login-error','Too many attempts. Try again in a minute.');else if(r.status===403)setText('login-error','Admin login is not configured on the server.');else if(r.status===401)setText('login-error','Wrong password.');else setText('login-error','Server replied HTTP '+r.status+' (is this the MySmartPlug server.py?)');}catch(e){console.error('Login failed:',e);setText('login-error','Login error: '+(e&&e.message?e.message:e));}}
  async function logout(){try{await fetch('/api/logout',{method:'POST'});}catch(e){}isAdmin=false;updateAuthUi();setControlMessage('Logged out.');}
  async function sendRelay(state){if(sending)return;sending=true;$('btn-on').disabled=$('btn-off').disabled=true;try{const r=await fetch('/api/relay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});if(r.status===401){isAdmin=false;updateAuthUi();setControlMessage('Session expired. Please log in again.');openLogin();return;}if(r.status===409){setControlMessage('Switch to MAINTENANCE mode first to control the outlet.');return;}if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();const id=num(d.command_id);pendingCommand=Number.isFinite(id)?{id,state}:null;setControlMessage('Command sent: '+state.toUpperCase()+'. Waiting for the device…');getSensorData();}catch(e){setControlMessage('Command failed: '+e.message);}finally{sending=false;$('btn-on').disabled=$('btn-off').disabled=false;}}

  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function parseDate(value){const d=new Date(value);return Number.isNaN(d.getTime())?null:d;}
  function dateLabel(value){
    const d=parseDate(value);
    return d?d.toLocaleString('en-GB',{timeZone:'Asia/Manila',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).replace(',', ','):String(value||'--');
  }
  function average(values){
    const nums=values.map(num).filter(Number.isFinite);
    return nums.length?nums.reduce((a,b)=>a+b,0)/nums.length:null;
  }
  function selectedHistoryRecords(records){
    const range=$('history-range')?.value||'36';
    if(range==='all')return records;
    const hours=Number(range),cutoff=Date.now()-hours*3600000;
    return records.filter(x=>{const d=parseDate(x.timestamp);return d&&d.getTime()>=cutoff;});
  }
  function renderHistoryChart(records, hoursLabel){
    const target=$('history-chart');if(!target)return;
    if(!records.length){target.innerHTML='<p class="history-empty">No sensor measurements recorded for this period. AUTO mode saves a reading every 3 minutes while the device is online.</p>';return;}
    const sorted=[...records].sort((a,b)=>(parseDate(a.timestamp)?.getTime()||0)-(parseDate(b.timestamp)?.getTime()||0));
    const width=900,height=250,left=58,right=18,top=18,bottom=42,plotW=width-left-right,plotH=height-top-bottom;
    const series=[
      {key:'voltage',name:'Voltage',cls:'chart-voltage',unit:'V'},
      {key:'current',name:'Current',cls:'chart-current',unit:'A'},
      {key:'temperature',name:'Temperature',cls:'chart-temperature',unit:'°C'}
    ];
    const x=i=>left+(sorted.length===1?plotW/2:i/(sorted.length-1)*plotW);
    const paths=series.map(s=>{
      const vals=sorted.map(r=>num(r[s.key])).filter(Number.isFinite);
      if(!vals.length)return '';
      const min=Math.min(...vals),max=Math.max(...vals),pad=(max-min)*.12||Math.max(Math.abs(max)*.04,1);
      const lo=min-pad,hi=max+pad;
      const pts=sorted.map((r,i)=>({v:num(r[s.key]),i})).filter(p=>Number.isFinite(p.v));
      const y=v=>top+(hi-v)/(hi-lo)*plotH;
      return `<polyline class="${s.cls}" points="${pts.map(p=>`${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}" />`;
    }).join('');
    const grid=Array.from({length:5},(_,i)=>{const y=top+i*plotH/4;return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${width-right}" y2="${y}"/>`;}).join('');
    const first=dateLabel(sorted[0].timestamp),last=dateLabel(sorted[sorted.length-1].timestamp);
    target.innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Sensor measurements over ${escapeHtml(hoursLabel)}">
      ${grid}<line class="chart-axis" x1="${left}" y1="${top}" x2="${left}" y2="${top+plotH}"/><line class="chart-axis" x1="${left}" y1="${top+plotH}" x2="${width-right}" y2="${top+plotH}"/>
      ${paths}
      <text class="chart-label" x="${left}" y="${height-12}">${escapeHtml(first)}</text>
      <text class="chart-label" text-anchor="end" x="${width-right}" y="${height-12}">${escapeHtml(last)}</text>
    </svg>`;
  }
  function renderHistoryTable(){
    const body=$('history-body');if(!body)return;
    const total=historyRecords.length,pages=Math.max(1,Math.ceil(total/HISTORY_PAGE_SIZE));
    historyPage=Math.min(Math.max(1,historyPage),pages);
    const start=(historyPage-1)*HISTORY_PAGE_SIZE,rows=historyRecords.slice(start,start+HISTORY_PAGE_SIZE);
    if(!rows.length)body.innerHTML='<tr><td colspan="7">No sensor measurements recorded for this period. AUTO mode saves a reading every 3 minutes while the device is online.</td></tr>';
    else body.innerHTML=rows.map((x,i)=>`<tr><td>${start+i+1}</td><td>${escapeHtml(dateLabel(x.timestamp))}</td><td>${fmt(x.voltage,1)}</td><td>${fmt(x.current,2)}</td><td>${fmt(x.temperature,1)}</td><td>${fmt(x.power,0)}</td><td>${escapeHtml(x.mode||'—')}</td></tr>`).join('');
    setText('history-log-count',`${total} sensor measurement records in selected period`);
    setText('history-page-label',`Page ${historyPage} of ${pages}`);
    $('history-prev').disabled=historyPage<=1;$('history-next').disabled=historyPage>=pages;
  }
  function renderHistory(d){
    const all=d.records||[],selected=selectedHistoryRecords(all);
    const range=$('history-range')?.value||'36';
    const cutoff=range==='all'?0:Date.now()-Number(range)*3600000;
    historyRecords=[...selected].sort((a,b)=>(parseDate(b.timestamp)?.getTime()||0)-(parseDate(a.timestamp)?.getTime()||0));
    const label=range==='all'?'all available hours':`last ${range} hours`;
    const dates=selected.map(x=>parseDate(x.timestamp)).filter(Boolean).sort((a,b)=>a-b);
    const elapsed=dates.length>1?(dates[dates.length-1]-dates[0])/3600000:0;
    setText('history-status',`${d.count||0} total saved readings · local SQLite database`);
    setText('history-total',String(selected.length));
    setText('history-duration',dates.length?`${elapsed.toFixed(1)} hours of recorded data`:'No recorded duration yet');
    const av=average(selected.map(x=>x.voltage)),ai=average(selected.map(x=>x.current)),at=average(selected.map(x=>x.temperature));
    setText('history-avg-voltage',av===null?'--':av.toFixed(1)+' V');
    setText('history-avg-current',ai===null?'--':ai.toFixed(2)+' A');
    setText('history-avg-temperature',at===null?'--':at.toFixed(1)+' °C');
    setText('history-chart-period',label[0].toUpperCase()+label.slice(1));
    renderHistoryChart(selected,label);
    historyPage=1;renderHistoryTable();
  }
  async function loadHistory(){
    if(!isAdmin)return;
    setText('history-status','Loading saved records…');
    try{
      const r=await fetch('/api/history?limit=10000',{cache:'no-store'});
      if(r.status===401){isAdmin=false;updateAuthUi();return;}
      const d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to load history');
      window.lastHistoryData=d;renderHistory(d);
    }catch(e){setText('history-status','Could not load database history.');const body=$('history-body');if(body)body.innerHTML=`<tr><td colspan="7">${escapeHtml(e.message)}</td></tr>`;}
  }
  $('history-range').addEventListener('change',()=>{if(window.lastHistoryData)renderHistory(window.lastHistoryData);else loadHistory();});
  $('history-prev').addEventListener('click',()=>{historyPage--;renderHistoryTable();});
  $('history-next').addEventListener('click',()=>{historyPage++;renderHistoryTable();});
  $('refresh-history').addEventListener('click',loadHistory);
  $('auth-btn').addEventListener('click',()=>isAdmin?logout():openLogin());
  $('control-login-btn').addEventListener('click',openLogin);$('login-cancel').addEventListener('click',closeLogin);$('login-form').addEventListener('submit',submitLogin);
  $('btn-on').addEventListener('click',()=>sendRelay('on'));$('btn-off').addEventListener('click',()=>sendRelay('off'));

  async function setSensor(name){
    if(!isAdmin||currentMode!=='MAINTENANCE'||sensorBusy)return;
    const nextMask=sensorEnabled(name)?(sensorMask&~SENSOR_BITS[name]):(sensorMask|SENSOR_BITS[name]);
    sensorBusy=true;updateSensorControls(sensorMask);setText('sensor-control-note','Sending '+name+' sensor command…');
    try{
      const r=await fetch('/api/sensors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({test_mask:nextMask})});
      const d=await r.json().catch(()=>({}));
      if(r.status===401){isAdmin=false;updateAuthUi();openLogin();return;}
      if(!r.ok)throw new Error(d.error||'HTTP '+r.status);
      sensorMask=Number(d.test_mask)&14;
      setText('sensor-control-note','Command queued. Waiting for the device to apply it.');
      getSensorData();
    }catch(e){setText('sensor-control-note','Could not change sensor: '+e.message);}
    finally{sensorBusy=false;updateSensorControls(sensorMask);}
  }
  document.querySelectorAll('[data-sensor-toggle]').forEach(b=>b.addEventListener('click',()=>setSensor(b.dataset.sensorToggle)));
  $('pw-toggle').addEventListener('click',()=>{const i=$('login-password'),show=i.type==='password';i.type=show?'text':'password';const b=$('pw-toggle');b.setAttribute('aria-pressed',show);b.setAttribute('aria-label',show?'Hide password':'Show password');b.querySelector('.eye-on').toggleAttribute('hidden',show);b.querySelector('.eye-off').toggleAttribute('hidden',!show);i.focus();});
  loadSession();getSensorData();setInterval(getSensorData,POLL_MS);
})();