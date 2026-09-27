// Opt-in review UI uses the same actor, pose path and clips as gameplay. Never enables saving.
import * as THREE from 'three';
export function installHeroReview(engine) {
  const h=engine.get('humanoid').all.find(h=>h.variant==='kento'&&h.group.visible&&h.group.position.length()<.5);
  if(!h)return;
  const panel=document.createElement('aside');panel.id='hero-review';
  panel.style.cssText='position:fixed;right:16px;top:16px;z-index:999;width:285px;padding:16px;background:#111e;color:#eee;font:14px/1.7 sans-serif;border:1px solid #bda66e';
  panel.innerHTML='<strong>渋沢健人 — 動作確認</strong><p>このチャットの採用画像が基準</p><div style="width:285px;height:300px;overflow:hidden;background:#252525"><img src="/docs/ref/kento-approved-concept.png" alt="採用画像の顔（原画そのもの）" style="height:440px;max-width:none;transform:translateX(-51%)"></div><div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:12px">'+[['idle','立ち姿'],['walk','歩く'],['run','走る'],['idle_combat','構え'],['jab','パンチ'],['kick','ハイキック']].map(([c,l])=>`<button data-clip="${c}">${l}</button>`).join('')+'</div><p><button data-view="front">正面</button> <button data-view="side">側面</button> <button data-view="back">背面</button> <button data-view="face">顔</button> <button data-view="face3q">顔・斜め</button> <button data-view="faceside">顔・横</button></p><button id="hero-pause">一時停止</button><label> 動作位置 <input type="range" min="0" max="99" value="0" aria-label="動作位置"></label><p role="status"></p><a href="/shibuya-cho/" style="color:#e2c574">ゲームへ戻る</a>';
  document.body.append(panel);
  const raw=engine.params.raw;
  let clip=['idle','walk','run','idle_combat','jab','kick'].includes(raw.anim)?raw.anim:'idle',phase=Number(raw.phase)||0,paused=raw.freeze==='1',last=performance.now();
  if(paused)panel.querySelector('#hero-pause').textContent='再生';
  h.setProp(null);
  const view=kind=>{
    const camera=engine.get('camera');
    const face=kind.startsWith('face');
    const pos=kind==='face3q'?[.37,1.63,1.14]:kind==='faceside'?[1.2,1.63,0]:kind==='side'?[4.3,1.15,0]:kind==='back'?[0,1.15,-4.3]:kind==='face'?[0,1.63,1.2]:[0,1.15,4.3];
    const look=face?[0,1.64,0]:[0,.93,0];
    camera.setFixed(new THREE.Vector3(...pos),new THREE.Vector3(...look),{fov:face?30:34});
    // Shift the composition left to leave the reference panel alongside the live model.
    engine.camera.setViewOffset(innerWidth,innerHeight,innerWidth*.12,0,innerWidth,innerHeight);
  };
  panel.addEventListener('click',e=>{
    if(e.target.dataset.clip){clip=e.target.dataset.clip;phase=0;}
    if(e.target.dataset.view)view(e.target.dataset.view);
    if(e.target.id==='hero-pause'){paused=!paused;e.target.textContent=paused?'再生':'一時停止';}
  });
  panel.querySelector('input').oninput=e=>{paused=true;phase=+e.target.value/100;panel.querySelector('#hero-pause').textContent='再生';};
  const draw=now=>{
    const dt=Math.min(.05,(now-last)/1000);last=now;
    if(!paused)phase=(phase+dt/(h.currentAction?.getClip().duration||4))%1;
    h.pose(clip,phase);
    panel.querySelector('input').value=Math.floor(phase*100);
    panel.querySelector('[role=status]').textContent=`${({idle:'立ち姿',walk:'歩行',run:'走行',idle_combat:'構え',jab:'パンチ',kick:'ハイキック'})[clip]} · ${Math.round(phase*100)}%`;
    requestAnimationFrame(draw);
  };
  view(raw.view||'front');requestAnimationFrame(draw);
}
