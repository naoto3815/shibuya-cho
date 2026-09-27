import { installBranchOffice } from './branchOffice.js';
import { CITY } from '../world/cityData.js';
import { playTrainOpening } from '../ui/trainOpening.js';
// Chapter-one progression. All Fight Club display names are fictional.
export function installDoubleDragon(m, THREE) {
  const hero='渋沢 健人', junior='商社時代の後輩';
  const gate=CITY.pedestrianStreets.find(s=>s.id==='centergai').gate.pos;
  const center=new THREE.Vector3(gate[0],0,gate[1]);
  if(m._doubleDragonInstalled)return;
  m._doubleDragonInstalled=true;
  installBranchOffice(m,THREE);
  m.STEPS.push(
    {id:'go_center',text:'玄凪会支社へ向かえ — センター街を抜けろ',pos:center,radius:5,head:'目的',ch:'第一章'},
    {id:'host_fight',text:'絡んできたホストを倒せ',pos:null,radius:0,head:'戦闘',ch:'第一章'},
    {id:'club_ready',text:'ファイトクラブの3人と向き合え',pos:center,radius:7,head:'目的',ch:'第一章'},
    {id:'club_fight',text:'ファイトクラブとの衝突を切り抜けろ',pos:null,radius:0,head:'戦闘',ch:'第一章'},
    {id:'go_branch',text:'センター街奥の玄凪会支社へ向かえ',pos:m.branchMark(0,3),radius:5,head:'目的',ch:'第一章'},
    {id:'branch_fight',text:'支社入口の構成員を倒せ',pos:null,radius:0,head:'戦闘',ch:'第一章'},
    {id:'hiiragi_reunion',text:'支社から現れた柊と向き合え',pos:m.branchMark(0,3),radius:5,head:'再会',ch:'第一章'}
  );
  const beat=(who,text,extra={})=>({t:Math.max(3.8,text.length*.12),say:[who,text],e:.12,rig:()=>m.storyShot(who),...extra});
  const reveal=id=>m.engine.events.emit('story:reveal',{id});
  const remove=cast=>{if(cast){m.clearNpcs(cast);cast._npcs=null;}};
  const actors=(spot,npcs)=>({spot,npcs:npcs.map((n,i)=>({key:'story'+i,name:n.name,seed:180+i,off:[(i-(npcs.length-1)/2)*1.4,0],face:'player',variant:n.variant||'wanderer',idle:n.idle||'idle'}))});
  const club=[{name:'朝比奈未空',variant:'club_miku',persona:'guard',idle:'phone'},{name:'朝比奈快',variant:'club_kai',persona:'brute'},{name:'那珂川天真',variant:'club_tenma',persona:'coward'}];
  const casts=()=>[m.storyCast,m.gangWitness,m.juniorWitness,m.hostWitness].filter(Boolean);
  m.syncStoryCast=()=>{
    const p=m.engine.player.position;
    for(const cast of casts()) {
      m.npcFor(cast);
      if(cast._pin)cast._pin.group.visible=false;
      for(const o of cast._npcs||[])if(m._hiiragiWalk?.actor!==o)o.h.group.rotation.y=Math.atan2(p.x-o.pos.x,p.z-o.pos.z);
    }
  };
  // Frame the actual speaker, including witnesses, instead of an empty enemy centroid.
  m.storyShot=who=>{
    m.syncStoryCast();
    const npcs=casts().flatMap(c=>c._npcs||[]), p=m.engine.player.position;
    const other=npcs.find(o=>o.def.name===who)||(who===hero?npcs[0]:null);
    if(!other)return m.rig({from:'player',back:3,side:1.4,look:who===hero?'player':'enemy',fov:43});
    const target=who===hero?p:other.pos, partner=who===hero?other.pos:p;
    const axis=partner.clone().sub(target).setY(0);
    if(axis.lengthSq()<.01)axis.set(0,0,1);
    axis.normalize();
    const side=new THREE.Vector3(axis.z,0,-axis.x);
    const pos=target.clone().addScaledVector(axis,2.6).addScaledVector(side,.8);
    pos.y=m.groundAt(pos.x,pos.z)+1.85;
    const look=target.clone();look.y+=1.45;
    return {pos:pos.toArray(),lookAt:look.toArray(),fov:43};
  };
  m.showStoryCast=(kind,filming=true)=>{
    remove(m.storyCast);
    const p=m.engine.player.position;
    m.storyCast=actors(kind==='junior'?[p.x+2.2,p.z-2.5]:[center.x,center.z],kind==='junior'?[{name:junior,variant:'ped_formal_portrait_4019'}]:kind==='host'?[{name:'キャッチのホスト',variant:'nightlife_king'}]:club.map(n=>({...n,idle:filming?n.idle:'idle'})));
    m.npcFor(m.storyCast);
    if(kind!=='junior')m.seatTwoShot(m.storyCast);
    if(kind==='club'){
      if(filming)m.storyCast._npcs?.[0]?.h.setProp?.('phone');
      remove(m.hostWitness);
      const base=m.storyCast._base||center;
      m.hostWitness=actors([base.x+3,base.z+1.5],[{name:'キャッチのホスト',variant:'nightlife_king'}]);
    }
    m.syncStoryCast();
  };
  m.clearStoryCast=()=>{m._hiiragiWalk=null;for(const key of ['storyCast','gangWitness','juniorWitness','hostWitness']){remove(m[key]);m[key]=null;}};
  m.resetChapter=()=>{
    m.clearChain();m._resClose=null;m.hideResults();m.clearChain();
    m.clearStoryCast();m.resetBranchEntrance();
    for(const sub of m.SUBSTORIES){remove(sub);sub.done=sub.id==='tout';}
    m.engine.get('enemy').clear();
    m.scene=null;m.talk=null;m.fightCtx=null;m.spawned=false;m._clubEntrancePlaying=false;
    m.startAt=null;m.startScene=null;m.startSubAt=null;m.startSub=null;
    m.hits=0;m.bestCombo=0;m.kos=0;m.fightT=0;
    m.holding=false;m.holdT=0;m.hideSay();m.setStageFocus(null);
    m.engine.get('player').respawn(new THREE.Vector3(-31,0,10.5),2.36);
    m.giveBriefcase();m.setYen(12480,true);
  };
  m.SCENES.hachiko=[
    beat(junior,'やめてください。そんな金、払う理由がない！',{do:()=>{m.stageFight();m.showStoryCast('junior');}}),
    beat('チンピラ','会社員なら金はあるだろ。話を長くするなよ。'),
    beat(hero,'……商社にいた頃の後輩か。何をされてる？'),
    beat(junior,'渋沢先輩……？ どうして、ここに。'),
    beat(hero,'話は後だ。その手を離せ。',{do:()=>m.dropBriefcase()}),
    beat('チンピラ','知り合いか。だったら、お前が払え！',{stamp:'喧'})
  ];
  m.SCENES.epilogue=[
    beat(junior,'助かりました、渋沢先輩。……先輩も、柊さんに呼ばれたんですか？',{do:()=>m.showStoryCast('junior')}),
    beat(hero,'お前もか。俺には、十年前の事件の真相を話したいと手紙が来た。'),
    beat(junior,'僕にも連絡がありました。十月一日の二十時、ハチ公前で会おうって。待っていたら、この人たちに……。'),
    beat(hero,'おい。なぜ、こいつを襲った。誰に言われた。',{do:()=>{
      const p=m.engine.player.position;
      remove(m.gangWitness);
      m.gangWitness=actors([p.x-1.8,p.z-2],[{name:'玄凪会の男',variant:'enforcer_b',idle:'sit'}]);
      m.npcFor(m.gangWitness);if(m.gangWitness._pin)m.gangWitness._pin.group.visible=false;
    }}),
    beat('玄凪会の男','ま、待ってくれ……！ 俺たちは、幹部の柊さんに命令されただけなんだ！'),
    beat(hero,'柊が……玄凪会の幹部だと？ あいつはどこにいる。'),
    beat('玄凪会の男','センター街の奥だ……玄凪会の支社がある。柊さんはそこにいる。頼む、もう勘弁してくれ。'),
    beat(junior,'僕たちを呼んでおいて、どうして……。'),
    beat(hero,'本人に聞く。お前は人のいる店に入って待ってろ。一人で追うな。')
  ];
  m.SCENES.host_intro=[
    beat('キャッチのホスト','お兄さん、ちょっと寄ってかない？ いい店あるよ。',{do:()=>m.showStoryCast('host')}),
    beat(hero,'急いでる。柊という男を見なかったか。'),
    beat('キャッチのホスト','柊？ 知らねえよ。誰それ。あんたも初めて見る顔だし。'),
    beat(hero,'ならいい。通してくれ。'),
    beat('キャッチのホスト','人に聞いといて、その態度かよ。待てって言ってんだろ！'),
    beat(hero,'……手を離せ。'),
    beat('キャッチのホスト','客でもねえくせに、偉そうにすんな！',{stamp:'喧'})
  ];
  // Legacy scene ID retained for existing preview links; no payment takes place.
  m.SCENES.host_payment=[
    beat('キャッチのホスト','分かった！ もう勘弁してくれ……。'),
    beat(hero,'もう誰かを無理に引き止めるな。分かったな。')
  ];
  m.SCENES.club_intro=[
    beat('朝比奈未空','……今の、撮れてる。もう倒れてる相手に、何をしてる？',{do:()=>{m.showStoryCast('club');reveal('fightclub_conflict');m.showMsg('撮影中','FIGHT CLUB — REC');}}),
    beat('朝比奈快','事情は？ その人、もう抵抗してないだろ。'),
    beat(hero,'カメラを向ける前に、こいつが何をしたか聞け。'),
    beat('那珂川天真','なら、まず落ち着いて話そうよ。'),
    beat('キャッチのホスト','助けて！ この男、いきなり殴って、まだ脅してくるんだ！'),
    beat('朝比奈未空','逃げるな。話が済むまで、ここにいてもらう。'),
    beat(hero,'腕を離せ。……俺にも、急ぐ理由がある。',{stamp:'喧'})
  ];
  m.SCENES.club_outro=[
    beat(junior,'待ってください！ 店の前から見ていました。その人は先に絡まれたんです！',{do:()=>{m.showStoryCast('club',false);remove(m.juniorWitness);m.juniorWitness=actors([center.x+2,center.z+2],[{name:junior,variant:'ped_formal_portrait_4019'}]);m.npcFor(m.juniorWitness);if(m.juniorWitness._pin)m.juniorWitness._pin.group.visible=false;}}),
    beat('朝比奈快','そっちの人にも聞く。最初に手を出したのは、どっちだ？'),
    beat('キャッチのホスト','……俺だよ。客引きを断られて、つい。柊って人のことも、本当に知らねえ。'),
    beat('那珂川天真','俺たちが見たのは、倒れた相手に詰め寄るところだけだった。早まったね。'),
    beat('朝比奈未空','決めつけたのは悪かった。この映像は、そのまま出さない。'),
    beat(hero,'俺も熱くなった。事情を話す前に、手を出したのは悪かった。'),
    beat(junior,'僕もハチ公前で助けてもらいました。絡んできたのは、玄凪会の連中で……。'),
    beat('朝比奈快','玄凪会……最近、この辺の半グレを使って勢力を広げてる。俺たちも調べてた。'),
    beat(hero,'柊という男に会いに来た。玄凪会の幹部になっているらしい。センター街の奥の支社へ行く。'),
    beat('朝比奈未空','俺たちも力を貸す。分かったことがあれば、知らせるよ。'),
    beat('那珂川天真','気をつけて。一人で抱え込まないで、困ったら連絡して。'),
    beat(hero,'……ああ。助かる。',{do:()=>reveal('fightclub_allies')})
  ];
  const guards=[{name:'玄凪会の門番',variant:'enforcer_b',persona:'guard'},{name:'玄凪会の構成員',variant:'enforcer_a',persona:'brute'},{name:'玄凪会の若衆',variant:'wanderer',persona:'coward'}];
  m.showBranchGuards=()=>{
    m.clearStoryCast();m.stageBranch();
    const at=m.branchMark(0,1.9);
    m.storyCast=actors([at.x,at.z],guards);m.storyCast.fixed=true;
    m.syncStoryCast();
  };
  m.SCENES.branch_intro=[
    beat(hero,'柊に会いに来た。ここにいるんだろう。',{do:m.showBranchGuards,rig:m.branchEntranceShot}),
    beat('玄凪会の門番','何だ、てめえ。誰の許可で来た。'),
    beat(hero,'本人に聞けば分かる。渋沢が来たと伝えてくれ。'),
    beat('玄凪会の門番','帰れ。これ以上、近づくな。'),
    beat(hero,'帰るつもりはない。柊を呼べ。'),
    beat('玄凪会の門番','……おい、お前ら。こいつを追い払え！',{stamp:'喧'})
  ];
  m.showHiiragi=()=>{
    m.clearStoryCast();m.stageBranch();m.resetBranchEntrance();
    const at=m.branchMark(0,.25);
    m.storyCast=actors([at.x,at.z],[{name:'柊 誠司',variant:'hiiragi',idle:'walk'}]);m.storyCast.fixed=true;
    m.syncStoryCast();
    const actor=m.storyCast._npcs?.[0];if(actor)m._hiiragiWalk={actor,t:0};
  };
  m.SCENES.hiiragi_reunion=[
    {t:3.5,do:m.showHiiragi,rig:m.branchEntranceShot},
    beat(hero,'……柊。',{do:()=>reveal('reunion')}),
    beat('柊 誠司','久しぶりだな、渋沢。'),
    beat(hero,'ハチ公で待ち合わせたはずだ。あいつを襲わせたのは、お前の命令なのか。'),
    beat('柊 誠司','……声を落とせ。'),
    beat(hero,'十年前の真相を話すんだろう。俺は、そのために来た。')
  ];
  // Preload the approved cast scan; never instantiate a procedural stand-in while it loads.
  m.prepareHiiragi=()=>{
    if(m._hiiragiLoading)return;
    m._hiiragiLoading=true;
    const hm=m.engine.get('humanoid');
    Promise.resolve(hm?.castScansReady?.('hiiragi')).then(()=>{
      m._hiiragiLoaded=!hm?.castScanReady || hm.castScanReady('hiiragi');
      if(!m._hiiragiLoaded)m.showMsg('読み込み待ち','柊のモデルを読み込めませんでした。再読み込みすると再会直前から再開できます。');
    }).catch(()=>{m.showMsg('読み込み待ち','再読み込みして、再会直前の保存から続けてください。');});
  };
  m.finishClub=()=>{m.clearStoryCast();m.setStep(8);m.prepareHiiragi();};
  m.startChapterFight=(kind)=>{
    m.clearStoryCast();
    const en=m.engine.get('enemy');en.clear();
    const p=m.engine.player;
    m.engine.get('player').respawn(p.position.clone(),p.yaw);
    m.fightCtx=kind;m.hits=0;m.bestCombo=0;m.kos=0;m.fightT=0;
    const defs=kind==='host'?[{name:'キャッチのホスト',variant:'nightlife_king',persona:'guard'}]:kind==='branch'?guards:club;
    const list=defs.map((d,i)=>{const a=p.yaw+(i-(defs.length-1)/2)*.55;const at=kind==='branch'?m.branchMark(-1-i*1.3,2.8):p.position.clone().add(new THREE.Vector3(Math.sin(a)*4,0,Math.cos(a)*4));at.y=m.groundAt(at.x,at.z);const e=en.spawn('chinpira',at,{...d,aggro:true,ownClothes:true});en.go(e,'approach');return e;});
    m.setStep(kind==='host'?5:kind==='branch'?9:7);m.engine.state.mode='combat';m.engine.events.emit('combat:start',{enemies:list});
  };
  m.finishHachiko=()=>{m.clearStoryCast();reveal('junior');reveal('gang');reveal('assault_order');reveal('hiiragi_whereabouts');m.setStep(4);};
  m.finishChapter=()=>{m.clearStoryCast();m.resetBranchEntrance();m.setStep(3);m.notice('第一章 完了','十年ぶりの再会',3.6);};
  m.chapterSceneEnd={epilogue:m.finishHachiko,host_intro:()=>m.startChapterFight('host'),host_payment:()=>m.playClubEntrance(),club_intro:()=>m.startChapterFight('club'),club_outro:m.finishClub,branch_intro:()=>m.startChapterFight('branch'),hiiragi_reunion:m.finishChapter};
  // Existing developer cutscene links run the real sequence without enabling saves.
  m.prepareChapterPreview=name=>{
    if(!Object.hasOwn(m.chapterSceneEnd,name))return false;
    if(name==='hiiragi_reunion'){m.stageBranch();m.setStep(10);m.prepareHiiragi();return true;}
    if(name==='branch_intro'){m.stageBranch();m.setStep(9);m.prepareHiiragi();}
    else if(name==='epilogue')m.stageHachiko();
    else {m.engine.get('player').respawn(center.clone().add(new THREE.Vector3(0,0,4)),Math.PI);if(name==='host_payment')m.showStoryCast('host');}
    m.startScene=name;m.startAt=.6;return true;
  };
  const previousEnd=m.onCombatEnd.bind(m);
  m.onCombatEnd=()=>{
    const ctx=m.fightCtx;
    if(!['main','host','club','branch'].includes(ctx)){previousEnd();return;}
    m.fightCtx=null;
    m.showResults(()=>{
      m.engine.get('enemy').clear();
      if(ctx==='main')m.play('epilogue',m.finishHachiko);
      if(ctx==='host'){m.showStoryCast('host');m.setStep(6);m.engine.get('menus')?.front?.save();m.play('host_payment',()=>m.playClubEntrance());}
      if(ctx==='club')m.play('club_outro',m.finishClub);
      if(ctx==='branch'){m.engine.state.mode='explore';m.setStep(10);m.engine.get('menus')?.front?.save();m.prepareHiiragi();}
    });
  };
  m.playClubEntrance=()=>{
    if(m._clubEntrancePlaying)return;
    m._clubEntrancePlaying=true;
    playTrainOpening(m.engine,()=>{
      m._clubEntrancePlaying=false;m.engine.state.frozen=false;
      m.setStep(7);m.play('club_intro',()=>m.startChapterFight('club'));
    },[{src:'/shibuya-cho/assets/story/fightclub-entrance.mp4',label:'センター街 — FIGHT CLUB',text:''}]);
  };
  m.updateChapter=()=>{
    if(m.engine.state.mode!=='explore'||m.scene||m.talk||m._resHold)return;
    const p=m.engine.player.position;
    if(m.index===4 && p.distanceTo(center)<5){m.setStep(5);m.play('host_intro',()=>m.startChapterFight('host'));}
    else if(m.index===6){m.playClubEntrance();}
    else if(m.index===8){m.prepareHiiragi();if(p.distanceTo(m.STEPS[8].pos)<5){m.setStep(9);m.play('branch_intro',()=>m.startChapterFight('branch'));}}
    else if(m.index===10){m.prepareHiiragi();if(m._hiiragiLoaded)m.play('hiiragi_reunion',m.finishChapter);}
  };
  // The old optional host quest is now a mandatory story encounter.
  const old=m.SUBSTORIES.find(s=>s.id==='tout');if(old)old.done=true;
}
