(function(){
function sv(p,s){return '<svg xmlns="http://www.w3.org/2000/svg" width="'+(s||16)+'" height="'+(s||16)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';}
var I={
 pads:'<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
 select:'<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.12 1.58a2 2 0 0 0-1.44 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z"/>',
 note:'<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
 draw:'<path d="M3 17c2.5-5 4.5-7 6-5s-1 6 1.5 6.5S15 11 17 9s3.5-1 4 0"/>',
 desktop:'<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
 phone:'<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
 send:'<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.63l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>',
 undo:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
 right:'<path d="m9 18 6-6-6-6"/>',
 back:'<path d="m15 18-6-6 6-6"/>',
 x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
 capture:'<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect width="10" height="8" x="7" y="8" rx="1"/>',
 plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
 text:'<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
 trash:'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
 pencil:'<path d="M21.17 6.81a1 1 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
 fork:'<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
 bell:'<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"/>'
};
function el(h){var d=document.createElement('div');d.innerHTML=h.trim();return d.firstChild;}
function $(s,r){return (r||document).querySelector(s);}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}

var s=(location.hash||'#pads').slice(1); if(['pads','open','start'].indexOf(s)<0)s='pads';
var PADS=[
 {t:'Pad in Patch',app:'Patch',chat:'Triage Patch Features Project',st:'working',n:3,when:'now',img:'pad-in-patch.jpg',kind:'d'},
 {t:'Meeting mode',app:'Patch',chat:'Triage Patch Features Project',st:'',n:3,when:'16:11',img:'meeting.jpg',kind:'d'},
 {t:'Patch settings',app:'Patch',chat:'Patch Settings Page Redesign',st:'',n:12,when:'26 Sep',img:'settings.jpg',kind:'d'},
 {t:'Android widgets',app:'Patch',chat:'App update: Android widgets',st:'',n:4,when:'29 Sep',img:'widgets.jpg',kind:'p'},
 {t:'Toilet, weight, jabs, worming',app:'Dog Log',chat:'Puppy Care Logging Features',st:'5',n:16,when:'28 Sep',img:'dog-care.jpg',kind:'p'},
 {t:'Weight',app:'Dog Log',chat:'Dog Weight Log Mockup',st:'',n:4,when:'27 Sep',img:'dog-weight.jpg',kind:'p'}
];

/* ---------- shell common to every screen ---------- */
$$('.dev-source-badge').forEach(function(n){n.remove();});
var NM=['Pad in Patch','Puppy Care Logging Features','Hetzner to Netcup migration','Dog Weight Log Mockup','Kitchen tap research','Bristol cinema this week','Patch tabs cleanup','Patch Settings Page Redesign','Garden lighting','Train to London Friday','Meal plan','Boiler service','Eleanor birthday ideas','Fish sleep audio','Basket watch','Forage nav bar','Prod sync fix','Yonder playlist','Freeagent October','Screwfix order'],k=0;
$$('.sb-row .name').forEach(function(n){if(n.textContent.trim()==='Manager')return;n.textContent=NM[(k++)%NM.length];});
$$('.sb-row .row-when, .sb-row .when-time').forEach(function(n){n.textContent='';});
$$('.sb-folder').forEach(function(f,i){var w=f.querySelector('.sb-folder-name, .name, span');$$('*',f).forEach(function(c){if(c.children.length===0&&/^[a-z-]+$/i.test(c.textContent.trim())&&c.textContent.trim().length>2)c.textContent=['portfolio','patch','goodgirl','home','work','misc'][i%6];});});
$$('.sb-row.active').forEach(function(r){r.classList.remove('active');});
var navJobs=$('[data-testid=nav-jobs]');
var navPads=el('<a class="nav-row" data-testid="nav-pads" href="/pads">'+sv(I.pads)+' Pads<span class="pip-navcount">5</span></a>');
navJobs.parentNode.insertBefore(navPads,navJobs);

var pane=$('.pane'), main=$('.chat-main');
function setChat(title,crumb){$('[data-testid=chat-title]').textContent=title;var f=$('[data-testid=folder-path]'),h=$('[data-testid=chat-host]');if(f)f.textContent=crumb[0];if(h)h.textContent=crumb[1];}
function collapse(){
  $('.three-col').classList.add('pip-collapsed');
  $('.three-col').appendChild(el('<button type="button" class="sidebar-expand-btn pip-expand" aria-label="Expand sidebar">'+sv(I.right)+'</button>'));
}
function msgs(list){
  var stream=$('.chat-stream-content'),uT=$('.msg-user',stream),aT=$('.msg-assistant',stream),gT=$('.tool-group',stream);
  stream.innerHTML='';
  list.forEach(function(m){
    var n;
    if(m[0]==='t'){n=gT.cloneNode(true);n.querySelector('.tool-summary-text').textContent=m[1];}
    else{n=(m[0]==='u'?uT:aT).cloneNode(true);$$('.msg-edit',n).forEach(function(x){x.remove();});n.querySelector('.content').innerHTML=m[1];}
    stream.appendChild(n);
  });
}
function padCard(p,extra){
  return '<div class="pip-card'+(p.kind==='p'?' is-phone':'')+'"><div class="pip-card-thumb"><img src="thumbs/'+p.img+'" alt=""></div><div class="pip-card-body"><div class="pip-card-title">'+sv(I.pads,14)+'<span>'+p.t+'</span></div><div class="pip-card-meta">'+(p.n==='New'?'New screen':p.n+' screens')+'</div></div>'+(extra||'<button type="button" class="pip-open">Open</button>')+'</div>';
}

/* ---------- 1. pads: where Pads live ---------- */
if(s==='pads'){
  navPads.classList.add('active');
  var groups={};PADS.forEach(function(p){(groups[p.app]=groups[p.app]||[]).push(p);});
  var h='<main class="pip-pads" data-testid="pads-route"><header class="pip-pads-head"><h1 class="display pip-title">Pads</h1><span class="pip-flex"></span><input class="jobs-search" placeholder="Search pads"><button type="button" class="pip-new">'+sv(I.plus)+'New Pad</button></header>';
  Object.keys(groups).forEach(function(app){
    h+='<div class="jobs-section-head">'+app+'<span class="pip-count">'+groups[app].length+'</span></div><div class="pip-grid">';
    groups[app].forEach(function(p){
      var badge=p.st==='working'?'<span class="pip-badge working"><span class="pip-dot"></span>Working</span>':p.st?'<span class="pip-badge">'+p.st+' changes</span>':'';
      h+='<a class="pip-tile'+(p.kind==='p'?' is-phone':'')+'" href="#open"><div class="pip-thumb"><img src="thumbs/'+p.img+'" alt=""></div><div class="pip-tile-body"><div class="pip-tile-row"><span class="pip-tile-title">'+p.t+'</span>'+badge+'</div><div class="pip-tile-meta"><span class="pip-chat"><span class="pip-sdot'+(p.st==='working'?' working':'')+'"></span>'+p.chat+'</span><span class="pip-when">'+p.when+'</span></div></div></a>';
    });
    h+='</div>';
  });
  h+='</main>';
  pane.querySelector('.pane-content').innerHTML=h;
}

/* ---------- 2. open: a Pad open beside its chat ---------- */
if(s==='open'){
  collapse();
  setChat('Puppy Care Logging Features',['goodgirl','Mac']);
  msgs([
   ['u','<div class="pip-sent"><div class="pip-sent-head">'+sv(I.pads,14)+'<b>Toilet, weight, jabs, worming</b><span>5 changes</span></div><div class="pip-sent-shots"><img src="thumbs/dog-care.jpg"><img src="thumbs/dog-care.jpg"><img src="thumbs/dog-weight.jpg"></div></div>'],
   ['t','Edited goodgirl/design/care/index.html'],
   ['a','<p>All 5 done: tile and page now "Toilet training", counts line and both sparklines gone, timer-off card reads "Toilet reminder".</p>'],
   ['a','<p>I also added a screen for when worming is overdue.</p>'+padCard({t:'Worming · overdue',n:'New',img:'dog-care.jpg',kind:'p'})]
  ]);
  var send='<button type="button" class="pip-send">'+sv(I.send,15)+'Send 3</button>';
  var screens=['Home','Home · toilet due','Toilet · timer on','Toilet · due','Toilet · timer off','Timer interval','Notifications','Health','Weight','Weigh Ruby','Vaccinations','Vaccination given','Add vaccination','Worming','Worming · overdue','Worming schedule','Wormed today'];
  var list=screens.map(function(n,i){return '<div class="pip-scr'+(i===0?' active':'')+'"><span>'+n+'</span>'+(i===0?'<span class="pip-scr-n">3</span>':n==='Worming · overdue'?'<span class="pip-scr-new"></span>':'')+'</div>';}).join('');
  var padPane=el('<div class="pane pip-padpane"><div class="pane-content"><main class="chat-main">'+
   '<header class="chat-head pip-padhead"><div class="chat-head-left"><div class="nav-history"><button type="button" class="nav-history-btn" aria-label="Back">'+sv(I.back,18)+'</button></div></div>'+
   '<div class="chat-head-title"><div class="chat-head-title-row"><h1 class="chat-title display">Toilet, weight, jabs, worming</h1></div><div class="chat-head-subline"><div class="chat-head-crumb"><span class="folder">Dog Log</span><span class="crumb-sep"> · </span><span class="host">17 screens</span></div></div></div>'+
   '<div class="chat-head-actions"><div class="head-action-rail">'+$('[data-testid=action-more]').outerHTML+'</div></div></header>'+
   '<div class="pip-bar"><div class="pip-seg"><button type="button">View</button><button type="button" class="on">Edit</button></div>'+
   '<div class="pip-tools"><button type="button" class="pip-tool on" title="Select">'+sv(I.select)+'</button><button type="button" class="pip-tool" title="Note">'+sv(I.note)+'</button><button type="button" class="pip-tool" title="Draw">'+sv(I.draw)+'</button><button type="button" class="pip-tool" title="Undo">'+sv(I.undo)+'</button></div>'+
   '<span class="pip-flex"></span><div class="pip-seg icon"><button type="button" title="Desktop">'+sv(I.desktop)+'</button><button type="button" class="on" title="Phone">'+sv(I.phone)+'</button></div></div>'+
   '<div class="pip-work"><nav class="pip-scrs">'+list+'</nav>'+
   '<div class="pip-canvas"><div class="pip-phone"><div class="pip-phone-in"><iframe src="dog-log/index.html#home" title="Home" scrolling="no"></iframe>'+
     '<div class="pip-marks">'+
       '<div class="pip-sel" style="left:16px;top:241px;width:358px;height:54px"><i></i><i></i><i></i><i></i><button type="button" class="pip-sel-x">'+sv(I.x,14)+'</button></div>'+
       '<div class="pip-note" style="left:150px;top:426px"><b>2</b>Make Health the first tile</div>'+
       '<svg class="pip-ink" viewBox="0 0 390 844" width="390" height="844"><path d="M206 312c-20-8-180-6-188 18-8 30 2 86 20 100 30 18 160 14 168-6 10-26 6-92 0-112z"/></svg>'+
     '</div></div></div></div>'+
   '<aside class="pip-changes"><div class="pip-changes-head"><span>Changes</span><span class="pip-count">3</span></div>'+
     '<div class="pip-chg"><span class="pip-chg-n">1</span><div><div class="pip-chg-k">'+sv(I.text,14)+'Text</div><div class="pip-chg-t">"Toilet training" → "Potty"</div></div><button type="button" class="pip-chg-x" aria-label="Remove">'+sv(I.x,14)+'</button></div>'+
     '<div class="pip-chg"><span class="pip-chg-n">2</span><div><div class="pip-chg-k">'+sv(I.note,14)+'Note</div><div class="pip-chg-t">Make Health the first tile</div></div><button type="button" class="pip-chg-x" aria-label="Remove">'+sv(I.x,14)+'</button></div>'+
     '<div class="pip-chg"><span class="pip-chg-n">3</span><div><div class="pip-chg-k">'+sv(I.draw,14)+'Drawing</div><div class="pip-chg-t">Around Socialisation</div></div><button type="button" class="pip-chg-x" aria-label="Remove">'+sv(I.x,14)+'</button></div>'+
     '<span class="pip-flex"></span>'+send+'</aside></div>'+
   '</main></div></div>');
  pane.parentNode.insertBefore(padPane,pane);
  pane.parentNode.insertBefore(el('<div class="pane-divider"></div>'),pane);
  pane.classList.add('pip-chatpane');
  $('.pip-phone iframe').addEventListener('load',function(){var d=this.contentDocument;if(!d)return;var w=d.createTreeWalker(d.body,NodeFilter.SHOW_TEXT),n;while((n=w.nextNode()))if(n.nodeValue.trim()==='Toilet training')n.nodeValue=n.nodeValue.replace('Toilet training','Potty');});
}

/* ---------- 3. start: three ways in ---------- */
if(s==='start'){
  collapse();
  setChat('Dog Weight Log Mockup',['goodgirl','Mac']);
  msgs([
   ['u','<p>The weight chart is hard to read on my phone. Try a couple of layouts.</p>'],
   ['t','Read goodgirl/mobile/src/screens/Weight.tsx'],
   ['a','<p>Two layouts are in a Pad, starting from the screen as it is now.</p>'+padCard({t:'Weight',n:4,img:'dog-weight.jpg',kind:'p'})]
  ]);
  var wrap=$('.head-hamburger');
  $('[data-testid=action-hamburger]').classList.add('pip-pressed');
  wrap.appendChild(el('<div class="head-menu pip-menu" role="menu">'+
   '<button type="button" class="head-menu-item">'+sv(I.pencil)+'Rename</button>'+
   '<button type="button" class="head-menu-item">'+sv(I.fork)+'Fork</button>'+
   '<button type="button" class="head-menu-item">'+sv(I.bell)+'Snooze</button>'+
   '<button type="button" class="head-menu-item pip-hl">'+sv(I.capture)+'Start a Pad from this screen</button>'+
   '<div class="pip-capture"><div class="pip-capture-shot"><img src="thumbs/dog-weight.jpg" alt=""></div><div class="pip-capture-meta"><b>Weight</b><span>Dog Log · now</span></div></div>'+
   '<button type="button" class="head-menu-item">'+sv(I.trash)+'Delete</button></div>'));
  var apps=[['Patch','p'],['Dog Log','d'],['Forage','f'],['Yonder','y'],['Fish Sleep','s']];
  var newPane=el('<div class="pane pip-newpane"><div class="pane-content"><main class="pip-new-route">'+
   '<header class="chat-head pip-newhead"><div class="chat-head-left"><div class="nav-history"><button type="button" class="nav-history-btn" aria-label="Back">'+sv(I.back,18)+'</button></div></div><div class="chat-head-title"><div class="chat-head-title-row"><h1 class="chat-title display">New Pad</h1></div></div><div class="chat-head-actions"></div></header>'+
   '<div class="pip-form">'+
   '<input class="pip-input" value="Chat header, fewer icons">'+
   '<div class="pip-label">Start from</div>'+
   '<div class="pip-apps"><button type="button" class="pip-app blank"><span class="pip-app-ic">'+sv(I.plus,18)+'</span>Blank</button>'+
     apps.map(function(a,i){return '<button type="button" class="pip-app'+(i===0?' on':'')+'"><span class="pip-app-ic '+a[1]+'">'+(a[1]==='d'?'<img src="dog-log/icon.png" alt="">':a[0][0])+'</span>'+a[0]+'</button>';}).join('')+'</div>'+
   '<div class="pip-shots">'+
     [['h-chat.jpg','Chat',1],['h-new.jpg','New chat'],['h-bus.jpg','Waiting on you'],['meeting.jpg','Meeting']].map(function(x){return '<button type="button" class="pip-shot'+(x[2]?' on':'')+'"><span class="pip-shot-img"><img src="thumbs/'+x[0]+'" alt=""></span><span class="pip-shot-name">'+x[1]+'</span></button>';}).join('')+
   '</div>'+
   '<div class="pip-row"><div class="pip-seg icon"><button type="button" class="on" title="Desktop">'+sv(I.desktop)+'</button><button type="button" title="Phone">'+sv(I.phone)+'</button></div><span class="pip-flex"></span><span class="pip-sel-chat">New chat ▾</span><button type="button" class="pip-create">Create</button></div>'+
   '</div></main></div></div>');
  pane.parentNode.insertBefore(newPane,pane.nextSibling);
  pane.parentNode.insertBefore(el('<div class="pane-divider"></div>'),newPane);
}
window.addEventListener('hashchange',function(){location.reload();});
})();
