// The graph and dossier share one fact-filtered model. Unknown truths never reach the DOM.
const portrait = (src, box, size) => ({src, box, size});
const DUO='/shibuya-cho/assets/menu/double-dragon-duo.png', CLUB='/shibuya-cho/assets/story/fightclub-entrance-reference.png';
const photos={
  junior:portrait('/shibuya-cho/assets/portraits/junior.png',[0,0,600,750],[600,750]),
  kento:portrait(DUO,[790,30,390,480],[1672,941]),
  hiiragi:portrait(DUO,[1195,28,395,480],[1672,941]),
  miku:portrait(CLUB,[710,65,210,255],[1672,941]),
  kai:portrait(CLUB,[453,82,205,250],[1672,941]),
  tenma:portrait(CLUB,[1050,100,205,250],[1672,941]),
};
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function relationshipModel(facts) {
  const known=new Set(facts), has=k=>known.has(k), nodes=[], edges=[], groups=[];
  const add=(id,name,role,x,y,w,h,sections,extra={})=>nodes.push({id,name,role,x,y,w,h,sections,photo:photos[id],...extra});
  const edge=(from,to,label,path,x,y,tone='trust',extra={})=>edges.push({from,to,label,path,x,y,tone,...extra});
  add('kento','渋沢 健人','主人公 · 経営コンサル',190,125,170,205,[
    ['人物像','元商社マン。現在は九州で中小企業向けの経営コンサルを営む。弱い立場の人を放っておけない。'],
    ['生い立ち','福岡県北九州市生まれ、苅田町育ち。父は抗争に巻き込まれて死亡し、母も突然行方不明になった。その後は叔父・叔母のもとで育つ。'],
    ['商社に入るまで','中高時代には喧嘩に明け暮れながらも、弱い者には手を差し伸べた。九州大学を卒業後、商社に入社する。'],
    ...(has('past_case')?[['十年前の事件','柊とともに社内の機密を知った。事件の後に退職し、九州へ帰った。']]:[]),
    ...(has('letter')?[['渋谷へ戻った理由','柊から届いた手紙を受け、十年ぶりに東京へ。待ち合わせは10月1日20時、渋谷町のハチ公前。']]:[]),
    ['残された謎','父の死と母の失踪の真相は、まだ分かっていない。'],
  ],{tone:'gold'});
  if(['letter','reunion','past_case','gang','hiiragi_whereabouts','infiltration'].some(has)) {
    add('hiiragi','柊 誠司',has('reunion')?'再会した親友':'商社時代の同期・親友',635,125,170,205,[
      ['渋沢との関係','同期入社の良きライバルであり、唯一無二の親友だった。'],
      ...(has('past_case')?[['十年前の事件','渋沢とともに社内の機密を知り、罪を着せられて懲役八年となった。']]:[]),
      ...(has('letter')?[['届いた手紙','「渋沢、久しぶりだな。10年前のあの事件の真相について話したいことがある。10月1日の20時に渋谷町のハチ公前で会おう。」']]:[]),
      ...(has('reunion')?[['再会','支社入口の構成員を倒すと、柊が支社から現れた。昔の商社マンとは雰囲気が異なり、渋沢に冷たい態度を見せた。その態度だけでは、本心は読み取れない。']]:[]),
      ...(has('gang')?[['所属についての証言','ハチ公前の玄凪会の男は、柊も同じ組織に所属していると話した。']]:[]),
      ...(has('assault_order')? [['襲撃命令の証言','後輩を襲った男は、怯えながら「幹部の柊さんに命令されただけ」と話した。なぜ襲撃を命じたのかは、まだ分からない。']] : []),
      ...(has('hiiragi_whereabouts')?[['判明した行方','玄凪会の男から、センター街奥にある玄凪会支社にいると聞き出した。']]:[]),
      ...(has('infiltration')?[['組織に入った目的','柊は冤罪の真相を追うため、組織の内部に入っていた。']]:[]),
    ],{tone:'red'});
    edge('kento','hiiragi','同期・親友','M360 193 H635',497,177,'trust',{both:true});
    if(has('letter'))edge('hiiragi','kento',has('reunion')?'渋谷で再会':'手紙で呼び出す','M635 247 H360',497,235,'gold');
  }
  if(has('company')){
    add('company','丸菱通商','二人のかつての勤務先',410,37,185,64,[['会社について','渋谷スクランブルスクエアに本社を置く商社。渋沢と柊が同期入社した。'],['関係','かつて二人が競い合い、互いを認め合った場所。']],{symbol:'丸菱',tone:'blue',kind:'organization'});
    edge('company','kento','かつて勤務','M410 69 H275 V125',325,59,'blue');
    if(nodes.some(n=>n.id==='hiiragi'))edge('company','hiiragi','同期入社','M595 69 H720 V125',669,59,'blue');
  }
  if(has('past_case')){
    add('past_case','十年前の機密事件','二人の人生が分かれた日',413,287,180,58,[['事件の発端','二人は商社の機密情報を知ってしまった。'],['事件の後','柊は罪を着せられて懲役八年。渋沢は退職して九州に帰り、中小企業向けの経営コンサルを始めた。'],['分かっていないこと','誰が何のために二人を巻き込んだのか。事件の真相は、調査を通して明らかになる。']],{kind:'event',symbol:'10',tone:'gold'});
    edge('past_case','kento','','M413 314 H360',0,0,'gold',{arrow:false});
    edge('past_case','hiiragi','','M593 314 H635',0,0,'gold',{arrow:false});
  }
  groups.push({id:'past',label:'商社時代から続く関係',x:165,y:16,w:665,h:347,tone:'blue'});
  if(has('junior')){
    add('junior','商社時代の後輩','ハチ公前で再会',35,452,150,170,[['ハチ公前での出会い','柊に呼ばれて待っていたところ、玄凪会の男たちに絡まれた。渋沢に助けられる。'],['柊との接点','渋沢と同じく、10月1日20時にハチ公前で会おうと連絡を受けていた。'],...(has('fightclub_allies')?[['誤解を解く証言','渋沢が先に絡まれていたことを伝え、ファイトクラブとの和解を助けた。']]:[])],{tone:'blue'});
    edge('kento','junior','救出・先輩と後輩','M190 226 H110 V452',112,392,'trust');
  }
  if(has('gang')){
    add('gang','玄凪会','九州から渋谷へ勢力を拡大',785,430,185,94,[['現在分かっていること','ハチ公前の男たちが所属する暴力団組織。九州を地盤に、渋谷へも勢力を広げている。'],['柊についての証言','男たちは、柊も玄凪会の一員だと話した。'],...(has('infiltration')?[['内部で真相を追う柊','柊は自分が罪を着せられた事件を調べるため、組織に入っていた。']]:[])],{kind:'organization',symbol:'玄凪',tone:'red'});
    edge('hiiragi','gang',has('infiltration')?'真相を追い組織へ':has('assault_order')?'幹部 ― 男の証言':'所属 ― 男の証言','M805 240 H885 V430',885,384,'red');
  }
  if(has('fightclub_conflict')||has('fightclub_allies')){
    const allies=has('fightclub_allies');
    for(const [id,name,x,role] of [['miku','朝比奈 未空',280,'格闘家・動画配信者'],['kai','朝比奈 快',438,'格闘家・動画配信者'],['tenma','那珂川 天真',596,'格闘家・動画配信者']]) {
      add(id,name,role,x,500,134,180,[['所属','格闘家と動画配信者の集団「ファイトクラブ」の一員。'],['出会いの場面で',({miku:'スマートフォンで撮影していた人物。渋沢を呼び止め、報酬の受け取りについて問いただした。',kai:'抵抗していない相手から金を取っているように見えたため、渋沢に事情を尋ねた。',tenma:'衝突する渋沢たちに、まず落ち着いて話そうと声をかけた。'})[id]],...(allies?[['和解のとき',({miku:'決めつけたことを謝り、誤解を招く映像をそのまま公開しないと伝えた。',kai:'ホストにも事実を確認した。玄凪会が渋谷の半グレを使って勢力を広げていることを調べていた。',tenma:'見たのは金を受け取った場面だけだったと認め、支社へ向かう渋沢を気遣った。'})[id]]]:[]),['渋沢との出会い','センター街で撮影中、渋沢がホストからコンサル報酬を受け取る場面を見て、衝突した。'],[allies?'現在の関係':'現在の関係',allies?'後輩の証言とホストへの確認で誤解が解け、渋沢に協力する仲間となった。':'金を巻き上げていると受け取り、渋沢と対立している。']],{tone:allies?'trust':'red'});
    }
    groups.push({id:'club',label:'ファイトクラブ',x:260,y:455,w:490,h:250,tone:allies?'trust':'red'});
    edge('kento','club',allies?'誤解が解け、共闘へ':'撮影をきっかけに対立','M275 330 V411 H505 V455',493,400,allies?'trust':'red');
  }
  if(has('dtc')){
    add('dtc','DTC','デトロイトトーマスコンサルティング',785,590,185,98,[['表向きの事業','中小企業への経営支援などを行うコンサルティング企業。'],['調査対象','渋沢が調査する企業。背後の関係は、まだ明らかになっていない。']],{kind:'organization',symbol:'DTC',tone:'blue'});
    edge('kento','dtc','調査対象','M190 290 H18 V742 H878 V688',690,740,'blue');
  }
  const ids=new Set([...nodes,...groups].map(n=>n.id));
  return {nodes,groups,edges:edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),width:1000,height:nodes.some(n=>n.y>400)?775:390};
}
function photoMarkup(node) {
  if(!node.photo)return `<div class="rm-placeholder" aria-hidden="true">${node.symbol?`<strong>${escape(node.symbol)}</strong>`:'<svg viewBox="0 0 100 110"><circle cx="50" cy="35" r="20"/><path d="M12 108V92c0-41 76-41 76 0v16"/></svg><span>顔写真未登録</span>'}</div>`;
  const p=node.photo;
  return `<svg class="rm-photo" viewBox="${p.box.join(' ')}" role="img" aria-label="${escape(node.name)}の顔写真" preserveAspectRatio="xMidYMid slice"><image href="${p.src}" width="${p.size[0]}" height="${p.size[1]}"/></svg>`;
}
export function renderRelationshipMap(facts) {
  const model=relationshipModel(facts);
  const colors={trust:'#338d87',gold:'#a57b3d',red:'#b75765',blue:'#6886a7'};
  return `<div class="rm-toolbar"><div><span class="rm-eyebrow">CHARACTER RELATIONSHIPS</span><h2>人物相関図</h2></div><div class="rm-zoom"><button type="button" data-rm-zoom="out" aria-label="相関図を縮小">−</button><output aria-live="polite">100%</output><button type="button" data-rm-zoom="in" aria-label="相関図を拡大">＋</button><button type="button" data-rm-zoom="fit">全体表示</button></div></div>
  <p class="rm-hint">顔写真を選ぶと人物の詳細へ。線は、その時点で判明している関係を示します。</p>
  <div class="rm-scroll" tabindex="0" aria-label="人物相関図。横にスクロールして移動できます"><div class="rm-size"><div class="rm-board" style="width:${model.width}px;height:${model.height}px">
  ${model.groups.map(g=>`<div class="rm-group ${g.tone}" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px"><span>${escape(g.label)}</span></div>`).join('')}
  <svg class="rm-lines" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="人物と組織の関係線"><defs>${Object.entries(colors).map(([k,c])=>`<marker id="rm-arrow-${k}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse"><path d="M1 1L7 4L1 7Z" fill="${c}"/></marker>`).join('')}</defs>
  ${model.edges.map(e=>`<g data-rm-edge="${e.from}:${e.to}" style="color:${colors[e.tone]}"><title>${escape(e.label)}</title><path d="${e.path}" fill="none" stroke="currentColor" stroke-width="2" ${e.arrow===false?'':`marker-end="url(#rm-arrow-${e.tone})"`} ${e.both?`marker-start="url(#rm-arrow-${e.tone})"`:''}/>${e.label?`<text x="${e.x}" y="${e.y}" text-anchor="middle">${escape(e.label)}</text>`:''}</g>`).join('')}</svg>
  ${model.nodes.map(n=>`<button type="button" class="rm-node ${n.kind||'character'} ${n.tone||''}" data-rm-person="${n.id}" aria-label="${escape(n.name)}の詳細を開く" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">${photoMarkup(n)}<span class="rm-node-caption"><strong>${escape(n.name)}</strong><small>${escape(n.role)}</small><i aria-hidden="true">＋</i></span></button>`).join('')}
  </div></div></div><div class="rm-legend"><span class="trust">親交・協力</span><span class="blue">勤務・調査</span><span class="red">組織・対立</span><span class="gold">事件・手紙</span></div><p class="footnote">新しい出会いや調査で人物・関係・詳細が更新されます。未判明の情報は表示されません。</p><div class="rm-detail-host"></div>`;
}
export function mountRelationshipMap(root,getFacts) {
  const scroll=root.querySelector('.rm-scroll'), size=root.querySelector('.rm-size'), board=root.querySelector('.rm-board'), host=root.querySelector('.rm-detail-host');
  if(!scroll)return {destroy(){}};
  let zoom=1, selected=null, trigger=null, previousOverflow='', autoFit=true, fitOverview=false;
  const apply=()=>{size.style.width=`${board.offsetWidth*zoom}px`;size.style.height=`${board.offsetHeight*zoom}px`;board.style.transform=`scale(${zoom})`;root.querySelector('.rm-zoom output').textContent=`${Math.round(zoom*100)}%`;};
  const fit=()=>{const widthFit=(scroll.clientWidth-4)/1000;zoom=fitOverview?Math.min(1,Math.max(.25,widthFit),Math.max(300,scroll.clientHeight)/board.offsetHeight):Math.min(1,Math.max(innerWidth<650?.65:.25,widthFit));apply();};
  const observer=new ResizeObserver(()=>{if(autoFit)fit();});observer.observe(scroll);fit();
  function close(){
    if(!selected)return;
    selected=null;host.innerHTML='';scroll.inert=false;root.querySelector('.rm-zoom').inert=false;
    root.style.overflow=previousOverflow;trigger?.focus({preventScroll:true});
  }
  function open(id,source){
    const model=relationshipModel(getFacts()), n=model.nodes.find(n=>n.id===id);if(!n)return;
    if(!selected){previousOverflow=root.style.overflow;trigger=source;}
    selected=id;root.style.overflow='hidden';scroll.inert=true;root.querySelector('.rm-zoom').inert=true;
    const linked=new Map();
    for(const edge of model.edges.filter(e=>(e.from===id||e.to===id)&&e.label)){const node=model.nodes.find(v=>v.id===(edge.from===id?edge.to:edge.from));if(!node)continue;const old=linked.get(node.id);if(old)old.edge={...old.edge,label:old.edge.label+'／'+edge.label};else linked.set(node.id,{edge,node});}
    const links=[...linked.values()];
    host.innerHTML=`<div class="rm-backdrop" data-rm-close></div><section class="rm-detail" role="dialog" aria-modal="true" aria-labelledby="rm-detail-title"><button type="button" class="rm-detail-close" data-rm-close>← 相関図に戻る <span>Esc</span></button><div class="rm-detail-hero">${photoMarkup(n)}<div><small>${escape(n.role)}</small><h2 id="rm-detail-title">${escape(n.name)}</h2><p>CHARACTER FILE</p></div></div><div class="rm-detail-body">${n.sections.map(([h,p])=>`<section><h3>${escape(h)}</h3><p>${escape(p)}</p></section>`).join('')}${links.length?`<section><h3>つながりのある人物・組織</h3>${links.map(({edge,node})=>`<button type="button" class="rm-related" data-rm-related="${node.id}"><span>${escape(node.name)}</span><small>${escape(edge.label)}</small><b>→</b></button>`).join('')}</section>`:''}</div></section>`;
    host.querySelector('button').focus({preventScroll:true});
  }
  const click=e=>{
    const target=e.target.closest('[data-rm-person],[data-rm-related],[data-rm-close],[data-rm-zoom]');if(!target)return;
    if(target.hasAttribute('data-rm-close'))close();
    else if(target.dataset.rmPerson)open(target.dataset.rmPerson,target);
    else if(target.dataset.rmRelated)open(target.dataset.rmRelated,trigger);
    else {const action=target.dataset.rmZoom;autoFit=action==='fit';fitOverview=autoFit;if(autoFit)fit();else{zoom=Math.max(.35,Math.min(1.5,zoom+(action==='in'?.15:-.15)));apply();}}
  };
  root.addEventListener('click',click);
  const key=e=>{
    if(!selected)return false;
    if(e.key==='Escape'){e.preventDefault();close();return true;}
    if(['Tab','ArrowDown','ArrowUp'].includes(e.key)){
      const buttons=[...host.querySelectorAll('button')];const i=buttons.indexOf(document.activeElement);
      e.preventDefault();buttons[(i+(e.shiftKey||e.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();return true;
    }
    return false;
  };
  return {key,destroy(){close();observer.disconnect();root.removeEventListener('click',click);host.innerHTML='';}};
}
