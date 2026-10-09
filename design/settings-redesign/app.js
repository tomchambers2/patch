(function(){
const tog = on=>`<div class="tog ${on?'on':''}" onclick="this.classList.toggle('on')"></div>`;
const row = (t,s,ctrl='')=>`<div class="row"><div class="t"><b>${t}</b>${s?`<small>${s}</small>`:''}</div>${ctrl}</div>`;
const group = (label,inner,extra='')=>`<div class="group">${label?`<span class="label">${label}</span>`:''}<div class="card">${inner}</div>${extra}</div>`;
const sel = (v)=>`<select><option>${v}</option></select>`;
const pills = (xs,on)=>`<div class="pills">${xs.map(x=>`<span class="${x===on?'on':''}" onclick="[...this.parentNode.children].forEach(c=>c.classList.remove('on'));this.classList.add('on')">${x}</span>`).join('')}</div>`;

// Claude tokens carry no email (Anthropic won't say whose a token is), so the
// label is the only name. ChatGPT sign-in does return the email.
const CLAUDE = [
  {n:'Personal Max',s:[34,61],r:['15:40','Tue']},
  {n:'Work Pro',s:[100,88],r:['15:40','Tue']},
  {n:'Backup',s:[0,12],r:['—','Thu']},
];
const GPT = [{n:'ChatGPT Plus',sub:'tom.chambers@gmail.com',s:[8,22],r:['16:10','Sat']}];
const cls = p=>p>=100?'x':p>80?'w':'';
function acctRows(list){
  return list.map((a,i)=>`<div class="acct" draggable="true">
    <span class="handle">⠿</span><span class="rank">${i+1}</span>
    <div><b style="font-weight:500">${a.n}</b>
      ${a.sub?`<div style="color:var(--ink-3);font-size:12.5px">${a.sub}</div>`:''}
      <div class="bars">
        <span>5-hour</span><div class="bar"><i class="${cls(a.s[0])}" style="width:${a.s[0]}%"></i></div><span>${a.s[0]}%</span><span>resets ${a.r[0]}</span>
        <span>Weekly</span><div class="bar"><i class="${cls(a.s[1])}" style="width:${a.s[1]}%"></i></div><span>${a.s[1]}%</span><span>resets ${a.r[1]}</span>
      </div></div>
    <button class="btn ghost">⋯</button></div>`).join('');
}

const PAGES = {
  credit:{title:'Usage',group:'Agents',html:()=>`
    <div class="phead"><h3>Usage</h3></div>
    ${group('Claude',acctRows(CLAUDE),'<div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn pri">Add account</button></div>')}
    ${group('ChatGPT',acctRows(GPT))}
    ${group('',row('Resume automatically when a limit resets','',tog(true)))}`},

  agent:{title:'Agent',group:'Agents',html:()=>`
    <div class="phead"><h3>Agent</h3></div>
    ${group('Defaults',
      row('Model for new chats','',sel('Opus 5.5'))+
      row('Permission mode','',sel('acceptEdits')))}
    ${group('Questions',
      row('Expire unanswered questions','',tog(true))+
      row('Expire after','',`<input type="text" value="600" style="width:70px"> s`))}
    ${group('Layers added to Claude Code',
      row('Patch tools prompt','Built-in default','<button class="btn">Edit</button>')+
      row('System prompt override','None','<button class="btn">Edit</button>')+
      row('Claude Code settings.json','','<button class="btn">Edit</button>'))}`},

  mcp:{title:'MCP',group:'Agents',html:()=>`
    <div class="phead"><h3>MCP</h3><button class="btn pri">Add server</button></div>
    ${group('Servers chats get',
      row('Patch','Built in','<span class="val">Always on</span>')+
      row('Playwright','npx @playwright/mcp --headless',tog(true))+
      row('Chrome DevTools','npx chrome-devtools-mcp --headless',tog(true)))}`},

  memories:{title:'Memories',group:'Agents',html:()=>`
    <div class="phead"><h3>Memories</h3></div>
    ${group('',row('Memory','',tog(true)))}
    <div style="display:flex;gap:10px;margin-bottom:10px;align-items:center">
      <input type="search" placeholder="Search 64 memories" style="flex:1">
      ${pills(['All','user','feedback','project','reference'],'All')}
    </div>
    <div class="mem">
      <div class="list">
        <div class="proj"><span class="label">portfolio</span><span class="chip">41</span></div>
        <div class="it on"><b>Android nav bar</b><small>never hide the system bar</small></div>
        <div class="it"><b>Build releases on the Mac</b><small>Hetzner only with --build-here</small></div>
        <div class="it"><b>Tom's phone</b><small>Android, ntfy for links</small></div>
        <div class="it"><b>Paid APIs</b><small>agree spend in advance</small></div>
        <div class="proj"><span class="label">patch</span><span class="chip">17</span></div>
        <div class="it"><b>Registry schema is strict</b><small>unknown keys fail load</small></div>
        <div class="it"><b>Deploy order</b><small>wire changes ship together</small></div>
        <div class="proj"><span class="label">home-assistant</span><span class="chip">6</span></div>
        <div class="it"><b>Hallway sensor</b><small>entity ids</small></div>
      </div>
      <div class="det">
        <h4>Android nav bar</h4>
        <div style="color:var(--ink-3)">feedback · portfolio · 13 Sep</div>
        <div class="body" contenteditable="true">Leave the system navigation bar alone. Never hide it.
The requirement is that no content sits under the bar: pad past useSafeAreaInsets().bottom, and count the inset once.</div>
        <div style="display:flex;gap:8px;margin-top:14px"><button class="btn dan">Delete</button></div>
      </div>
    </div>`},

  manager:{title:'Manager',group:'Agents',html:()=>`
    <div class="phead"><h3>Manager</h3></div>
    ${group('Manager',
      row('Enabled','',tog(true))+
      row('Quiet hours','',`<input type="time" value="22:30"> – <input type="time" value="07:30">`)+
      row('Address word','',`<input type="text" value="Patch" style="width:120px">`))}
    ${group('Manager and Speakers threads',
      row('Model','',sel('Sonnet 5'))+
      row('Start a fresh session daily','',tog(true))+
      row('At','',`<input type="time" value="04:00">`))}`},

  voice:{title:'Voice',group:'Agents',html:()=>`
    <div class="phead"><h3>Voice</h3></div>
    ${group('Engine',
      ['Dictation','Hands-free','Call','Voice device'].map((s,i)=>row(s,'',
        pills(['local','gemini','openai'],i===2?'openai':'local')+(i?'<span style="width:10px"></span>'+pills(['direct','light','heavy'],'light'):''))).join(''))}
    ${group('Speaking',row('Voice','',sel('af_heart'))+row('Say the chat name every','',`<input type="text" value="3" style="width:50px"> replies`))}
    ${group('Voice devices',row('None paired','','<button class="btn">Pair a device</button>'))}`},

  machines:{title:'Hosts',group:'Setup',html:()=>`
    <div class="phead"><h3>Hosts</h3><button class="btn pri">Add a host</button></div>
    ${group('',
      row('<span class="dot"></span> Hetzner','linux · seen 2s ago','<span class="chev">›</span>')+
      row('<span class="dot off"></span> Mac','macOS · seen 3h ago','<button class="btn">Update</button><span class="chev">›</span>'))}
    <span class="label" style="display:block;margin:0 0 8px 2px">Hetzner</span>
    ${group('',
      row('Name','',`<input type="text" value="Hetzner" style="width:160px">`)+
      row('Remove this host','','<button class="btn dan">Remove</button>'))}`},

  keys:{title:'Keys',group:'Setup',html:()=>`
    <div class="phead"><h3>Keys</h3></div>
    ${group('Provider keys',
      row('Gemini','…4f2a','<button class="btn">Replace</button><button class="btn dan">Revoke</button>')+
      row('OpenAI','…9c1e','<button class="btn">Replace</button><button class="btn dan">Revoke</button>')+
      row('Groq','Not set','<button class="btn">Add</button>'))}
    ${group('Secrets',
      row('<span class="mono">TODOIST_TOKEN</span>','••••••••','<button class="btn">Edit</button>')+
      row('<span class="mono">NTFY_TOPIC</span>','••••••••','<button class="btn">Edit</button>'),
      `<div style="margin-top:8px"><button class="btn">Add secret</button></div>`)}`},

  devices:{title:'Devices',group:'Setup',html:()=>`
    <div class="phead"><h3>Devices</h3><button class="btn pri">Link a device</button></div>
    ${group('Linked',
      row('<span class="dot"></span> Desktop · Mac','This device','')+
      row('<span class="dot"></span> Pixel 9','Android','<button class="btn dan">Revoke</button>')+
      row('<span class="dot off"></span> Chrome · Hetzner','Web · seen 4d ago','<button class="btn dan">Revoke</button>'))}
    ${group('Google',row('Connected','calendar, gmail.readonly','<button class="btn dan">Disconnect</button>'))}`},

  updates:{title:'Updates',group:'System',pip:true,html:()=>`
    <div class="phead"><h3>Updates</h3><button class="btn pri">Check now</button></div>
    ${group('Behind',row('Mac daemon','0.48.1 → 0.48.2','<button class="btn">Update</button>'))}
    ${group('Versions',
      row('This app','desktop 2.14.0 · ui a91c3e2','')+
      row('Server','a91c3e2','')+
      row('Hetzner daemon','0.48.2','')+
      row('Android APK','patch-2.14.0-0925.apk',''))}
    ${group('',row('Last checked','12:02',''))}`},

  account:{title:'Account',group:'System',html:()=>`
    <div class="phead"><h3>Account</h3></div>
    ${group('',
      row('Account','<span class="mono">acct_7f3c21</span>','')+
      row('Server','<span class="mono">patch.tomchambers.me</span>',''))}
    ${group('This device',row('Sign this device out','','<button class="btn dan">Deactivate</button>'))}`},
};

const order = ['credit','agent','mcp','memories','manager','voice','machines','keys','devices','updates','account'];
function renderNav(){
  let last='', h='<h2>Settings</h2>';
  for(const k of order){const p=PAGES[k];
    if(p.group!==last){h+=`<div class="label grp">${p.group}</div>`;last=p.group}
    h+=`<button class="${k===window.__cur?'on':''}" onclick="go('${k}')">${p.title}${p.pip?'<i class="pip"></i>':''}</button>`}
  document.getElementById('nav').innerHTML=h;
}
function wireDrag(){
  document.querySelectorAll('.card').forEach(card=>{
    let dragEl=null;
    card.querySelectorAll('.acct').forEach(el=>{
      el.addEventListener('dragstart',()=>{dragEl=el;el.classList.add('dragging')});
      el.addEventListener('dragend',()=>{el.classList.remove('dragging');
        [...card.querySelectorAll('.acct')].forEach((a,i)=>{a.querySelector('.rank').textContent=i+1})});
      el.addEventListener('dragover',e=>{e.preventDefault();if(!dragEl||dragEl===el)return;
        const r=el.getBoundingClientRect();card.insertBefore(dragEl,e.clientY<r.top+r.height/2?el:el.nextSibling)});
    });
  });
}
// Each page has its own address (#agent), so Pad can list them as screens.
// No hash: the section list on a phone, Credit beside the sidebar on desktop.
function show(k){
  window.__cur=k;renderNav();
  document.getElementById('page').innerHTML=PAGES[k].html().replace('<div class="phead">','<div class="phead"><button class="mback" onclick="back()">←</button>');
  window.scrollTo(0,0);wireDrag();
}
function route(){
  var k = location.hash.slice(1);
  if (PAGES[k]) { show(k); document.querySelector('.desk').classList.add('open'); }
  else { show('credit'); document.querySelector('.desk').classList.remove('open'); }
}
window.go = function(k){ location.hash = k; };
window.back = function(){ location.hash = ''; };
window.addEventListener('hashchange', route);
route();

})();
