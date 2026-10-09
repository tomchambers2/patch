(function(){
var ICON='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>';
var CONVO=[
 ['u','Can you set up the agenda doc for the loyalty sync?'],
 ['a','Done — "Loyalty sync 7 Oct" is in the team folder with last week\'s open items carried over.'],
];
var LIVE=[
 ['u','What\'s the "points ledger" thing Dev keeps mentioning?'],
 ['a','It\'s the table recording every points earn and burn per member. Dev wants it in its own service because month-end statement runs lock it for about 20 minutes.','From the repo · loyalty-api/ledger/README.md'],
 ['u','Check if Sam\'s sandbox has run out of credit — their tests are failing'],
 ['a','Yes — Sam\'s sandbox is at £0.40, under the £5 floor, so every test call is rejected. Top-up added to Actions.'],
];
var AFTER=LIVE.concat([['u','Write this up as notes for the team'],['a','Draft notes are in "Loyalty sync 7 Oct" — three decisions, five actions, two open questions.']]);
function el(h){var d=document.createElement('div');d.innerHTML=h.trim();return d.firstChild;}
function render(){
  var s=(location.hash||'#live').slice(1); if(['start','live','after'].indexOf(s)<0)s='live';
  document.querySelectorAll('.chat-head .chat-title-text, [data-testid=chat-title]').forEach(function(n){n.textContent='Loyalty app — weekly sync';});
  var t=document.querySelector('[data-testid=chat-title-name]')||document.querySelector('.chat-title');
  var crumbF=document.querySelector('[data-testid=folder-path]'),crumbH=document.querySelector('[data-testid=chat-host]');
  if(crumbF)crumbF.textContent='work'; if(crumbH)crumbH.textContent='Mac';
  var NM=['Screwfix order','Hetzner to Netcup migration','Loyalty app — weekly sync','Dog Log sync bug','Kitchen tap research','Bristol cinema this week','Patch tabs cleanup','Freeagent October','Garden lighting','Train to London Friday','Meal plan','Shaver stand','Boiler service','Eleanor birthday ideas','Tax return notes','Fish sleep audio','Basket watch','Forage nav bar','Prod sync fix','Yonder playlist'],k=0; document.querySelectorAll('.sb-row .name').forEach(function(n){var r=n.closest('.sb-row'); if(n.textContent.trim()==='Manager')return; n.textContent=r.classList.contains('active')?'Loyalty app — weekly sync':NM[(k++)%NM.length].replace('Loyalty app — weekly sync','Q3 retention deck');});
  document.querySelectorAll('.sb-row .row-when .when-time').forEach(function(n){n.textContent='';});
  // conversation
  var stream=document.querySelector('.chat-stream-content');
  var uT=stream.querySelector('.msg-user'),aT=stream.querySelector('.msg-assistant');
  var msgs=s==='start'?CONVO:s==='live'?LIVE:AFTER;
  stream.innerHTML='';
  msgs.forEach(function(m){var n=(m[0]==='u'?uT:aT).cloneNode(true);n.querySelector('.content').innerHTML='<p>'+m[1]+'</p>'+(m[2]?'<div class="mm-src">'+m[2]+'</div>':'');stream.appendChild(n);});
  // meeting button beside Call
  var call=document.querySelector('[data-testid=call-btn]');
  var mb=call.cloneNode(true);mb.className='call-btn meeting-btn'+(s==='live'?' mm-live':'');mb.title=s==='live'?'End meeting':'Meeting';mb.setAttribute('aria-label','meeting');mb.innerHTML=ICON;
  call.after(mb);
  if(s==='start')return;
  document.querySelector('[data-testid=composer-input]').placeholder='Ask about the meeting, or tell it to do something';
  // layout
  var main=document.querySelector('.chat-main'),sec=document.querySelector('.chat-stream'),comp=document.querySelector('.composer');
  main.classList.add('mm-on');
  var body=el('<div class="mm-body"><div class="mm-left"></div><aside class="mm-panel"></aside></div>');
  main.insertBefore(body,sec);
  var left=body.firstChild;left.appendChild(sec);
  left.appendChild(el('<div class="mm-actions"><div class="mm-actions-in">'+
   '<div class="mm-label">Actions</div>'+
   '<div class="mm-card"><div class="w"><b>Top up Sam\'s sandbox credit by £50</b><div class="y">Sam: "my tests keep failing since this morning" · 31:40</div></div><button class="mm-do">Do it</button><button class="mm-dis">Dismiss</button></div>'+
   '<div class="mm-card"><div class="w"><b>Create ticket: move points ledger to its own service</b><div class="y">Agreed by Dev and Priya · 22:05</div></div><button class="mm-do">Do it</button><button class="mm-dis">Dismiss</button></div>'+
   '<div class="mm-card done"><div class="w"><span class="tk">✓</span>Sent Priya the Q3 retention deck</div><span class="y">09:12</span></div>'+
   '</div></div>'));
  left.appendChild(comp);
  body.lastChild.innerHTML=(s==='live'?'<div class="mm-head"><span class="mm-pill"><span class="mm-dot"></span>Live · 34:12</span><span style="flex:1"></span><button class="mm-btn">Pause</button><button class="mm-end">End</button></div>':'<div class="mm-head"><span class="mm-pill ended">Ended · 52 min</span></div>')+(s==='live'
   ?'<div class="mm-now"><div class="mm-label">Now</div><h4>Dev is arguing the ledger split should wait until after Black Friday</h4><ul><li>Risk: migrating during peak traffic</li><li>Priya wants it before the statement run on the 1st</li><li>Nobody has costed running both in parallel</li></ul><div class="mm-who">Dev, Priya · last 2 min</div></div>'
   :'<div class="mm-now"><div class="mm-label">Summary</div><h4>Ledger split goes ahead in November behind a flag; Sam\'s failures were credit, not code</h4><ul><li>3 decisions · 5 actions · 2 open questions</li></ul></div>')+
   '<div><div class="mm-label">Discussed</div>'+
   '<div class="mm-topic"><div class="r"><span class="tm">31:40</span><span class="nm">Sam\'s failing tests</span></div><ul><li>Sandbox out of credit, not a code bug</li></ul></div>'+
   '<div class="mm-topic"><div class="r"><span class="tm">22:05</span><span class="nm">Points ledger split</span><span class="mm-dec">Decided</span></div><ul><li>Own service; Postgres stays for members</li><li>Timing still open</li></ul></div>'+
   '<div class="mm-topic"><div class="r"><span class="tm">09:12</span><span class="nm">Q3 retention numbers</span></div><ul><li>Churn down 4% after tiered rewards</li><li>Priya needs the deck for Thursday</li></ul></div>'+
   '<div class="mm-topic"><div class="r"><span class="tm">00:30</span><span class="nm">Release 4.2</span><span class="mm-dec">Decided</span></div><ul><li>Ships Monday with the login timeout fix</li></ul></div></div>'+
   '<details class="mm-tx"><summary>Transcript</summary><div class="ln"><div><span>33:58 Dev</span>If we do it in November we\'re migrating in the busiest week of the year.</div><div><span>34:03 Priya</span>But the statement run on the first will lock it again.</div><div><span>34:09 Sam</span>Can we run both in parallel for a week?</div><div><span>34:12 Dev</span>Maybe, nobody\'s costed that.</div></div></details>';
}
window.addEventListener('hashchange',function(){location.reload();});render();
})();
