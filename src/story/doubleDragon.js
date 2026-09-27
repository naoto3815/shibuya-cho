import { CITY } from '../world/cityData.js';
import { playTrainOpening } from '../ui/trainOpening.js';
// Chapter-one story progression. Real-person roles below are fictional game dramatization.
export function installDoubleDragon(m, THREE) {
  const hero='渋沢 健人', junior='商社時代の後輩';
  const gate=CITY.pedestrianStreets.find(s=>s.id==='centergai').gate.pos;
  const center=new THREE.Vector3(gate[0],0,gate[1]);
  if(m._doubleDragonInstalled)return;
  m._doubleDragonInstalled=true;
  m.STEPS.push(
    {id:'go_center',text:'柊を探してセンター街の入口へ向かえ',pos:center,radius:5,head:'目的',ch:'第一章'},
    {id:'host_fight',text:'絡んできたホストを倒せ',pos:null,radius:0,head:'戦闘',ch:'第一章'},
    {id:'club_ready',text:'ファイトクラブの3人と向き合え',pos:center,radius:7,head:'目的',ch:'第一章'},
    {id:'club_fight',text:'ファイトクラブとの衝突を切り抜けろ',pos:null,radius:0,head:'戦闘',ch:'第一章'}
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
      for(const o of cast._npcs||[])o.h.group.rotation.y=Math.atan2(p.x-o.pos.x,p.z-o.pos.z);
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
  m.clearStoryCast=()=>{for(const key of ['storyCast','gangWitness','juniorWitness','hostWitness']){remove(m[key]);m[key]=null;}};
  m.resetChapter=()=>{
    m.clearChain();m._resClose=null;m.hideResults();m.clearChain();
    m.clearStoryCast();
    for(const sub of m.SUBSTORIES){remove(sub);sub.done=sub.id==='tout';}
    m.engine.get('enemy').clear();
    m.scene=null;m.talk=null;m.fightCtx=null;m.spawned=false;m._clubEntrancePlaying=false;
    m.startAt=null;m.startScene=null;m.startSubAt=null;m.startSub=null;
    m.hits=0;m.bestCombo=0;m.fightYen=0;m.kos=0;m.fightT=0;
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
    beat(junior,'僕にも連絡がありました。今夜二十時、ハチ公前で会おうって。待っていたら、この人たちに……。'),
    beat(hero,'おい。柊を知ってるな。どこにいる。',{do:()=>{
      const p=m.engine.player.position;
      remove(m.gangWitness);
      m.gangWitness=actors([p.x-1.8,p.z-2],[{name:'玄凪会の男',variant:'enforcer_b',idle:'sit'}]);
      m.npcFor(m.gangWitness);if(m.gangWitness._pin)m.gangWitness._pin.group.visible=false;
    }}),
    beat('玄凪会の男','……柊さんなら、俺たちと同じ玄凪会の人間だ。'),
    beat(hero,'玄凪会……。柊が、あの組織に？'),
    beat('玄凪会の男','さっきセンター街へ入っていった。それ以上は知らねえ。本当だ。'),
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
  m.SCENES.host_payment=[
    beat('キャッチのホスト','分かった、払う！ もう勘弁してくれ……。'),
    beat(hero,'世の中には、自分より強い相手もいる。リスク管理の助言料だ。')
  ];
  m.SCENES.club_intro=[
    beat('朝比奈未空','……今の、撮れてる。その人から金を取ったよな。',{do:()=>{m.showStoryCast('club');reveal('fightclub_conflict');m.showMsg('撮影中','FIGHT CLUB — REC');}}),
    beat('朝比奈快','事情は？ その人、もう抵抗してないだろ。'),
    beat(hero,'カメラを向ける前に、こいつが何をしたか聞け。'),
    beat('那珂川天真','なら、まず落ち着いて話そうよ。'),
    beat('キャッチのホスト','助けて！ この男、いきなり金を要求して……！'),
    beat('朝比奈未空','逃げるな。話が済むまで、ここにいてもらう。'),
    beat(hero,'腕を離せ。……俺にも、急ぐ理由がある。',{stamp:'喧'})
  ];
  m.SCENES.club_outro=[
    beat(junior,'待ってください！ 店の前から見ていました。その人は先に絡まれたんです！',{do:()=>{m.showStoryCast('club',false);remove(m.juniorWitness);m.juniorWitness=actors([center.x+2,center.z+2],[{name:junior,variant:'ped_formal_portrait_4019'}]);m.npcFor(m.juniorWitness);if(m.juniorWitness._pin)m.juniorWitness._pin.group.visible=false;}}),
    beat('朝比奈快','そっちの人にも聞く。最初に手を出したのは、どっちだ？'),
    beat('キャッチのホスト','……俺だよ。客引きを断られて、つい。柊って人のことも、本当に知らねえ。'),
    beat('那珂川天真','俺たちが見たのは、金を受け取ったところだけだった。早まったね。'),
    beat('朝比奈未空','決めつけたのは悪かった。この映像は、そのまま出さない。'),
    beat(hero,'俺も熱くなった。金の取り方も、褒められたものじゃない。'),
    beat(junior,'僕もハチ公前で助けてもらいました。絡んできたのは、玄凪会の連中で……。'),
    beat('朝比奈快','玄凪会……最近、この辺の半グレを使って勢力を広げてる。俺たちも調べてた。'),
    beat(hero,'俺は柊という男を探してる。あいつのことを知ってるなら、力を貸してくれ。'),
    beat('朝比奈未空','まず話を聞かせて。次は、拳を使う前にな。'),
    beat('那珂川天真','じゃあ、飯でも行こう。今度の相談料は、なしで。'),
    beat(hero,'……ああ。助かる。',{do:()=>reveal('fightclub_allies')})
  ];
  m.startChapterFight=(kind)=>{
    m.clearStoryCast();
    const en=m.engine.get('enemy');en.clear();
    const p=m.engine.player;
    m.engine.get('player').respawn(p.position.clone(),p.yaw);
    m.fightCtx=kind;m.hits=0;m.bestCombo=0;m.fightYen=0;m.kos=0;m.fightT=0;
    const defs=kind==='host'?[{name:'キャッチのホスト',variant:'nightlife_king',persona:'guard'}]:club;
    const list=defs.map((d,i)=>{const a=p.yaw+(i-(defs.length-1)/2)*.55;const at=p.position.clone().add(new THREE.Vector3(Math.sin(a)*4,0,Math.cos(a)*4));at.y=m.groundAt(at.x,at.z);const e=en.spawn('chinpira',at,{...d,aggro:true,ownClothes:true});en.go(e,'approach');return e;});
    m.setStep(kind==='host'?5:7);m.engine.state.mode='combat';m.engine.events.emit('combat:start',{enemies:list});
  };
  m.finishHachiko=()=>{m.clearStoryCast();reveal('junior');reveal('gang');reveal('hiiragi_whereabouts');m.setStep(4);};
  m.finishChapter=()=>{m.clearStoryCast();m.setStep(3);m.notice('第一章 完了','拳の向こう側',3.6);};
  m.chapterSceneEnd={epilogue:m.finishHachiko,host_intro:()=>m.startChapterFight('host'),host_payment:()=>m.playClubEntrance(),club_intro:()=>m.startChapterFight('club'),club_outro:m.finishChapter};
  // Existing developer cutscene links run the real sequence without enabling saves.
  m.prepareChapterPreview=name=>{
    if(!Object.hasOwn(m.chapterSceneEnd,name))return false;
    if(name==='epilogue')m.stageHachiko();
    else {m.engine.get('player').respawn(center.clone().add(new THREE.Vector3(0,0,4)),Math.PI);if(name==='host_payment')m.showStoryCast('host');}
    m.startScene=name;m.startAt=.6;return true;
  };
  const previousEnd=m.onCombatEnd.bind(m);
  m.onCombatEnd=()=>{
    const ctx=m.fightCtx;
    if(!['main','host','club'].includes(ctx)){previousEnd();return;}
    m.fightCtx=null;
    m.showResults(()=>{
      m.engine.get('enemy').clear();
      if(ctx==='main')m.play('epilogue',m.finishHachiko);
      if(ctx==='host'){m.showStoryCast('host');m.setStep(6);m.engine.get('menus')?.front?.save();m.play('host_payment',()=>m.playClubEntrance());}
      if(ctx==='club')m.play('club_outro',m.finishChapter);
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
  };
  // The old optional host quest is now a mandatory story encounter.
  const old=m.SUBSTORIES.find(s=>s.id==='tout');if(old)old.done=true;
}
