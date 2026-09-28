// One continuous descent in the live city; controls unlock only after follow-camera handoff.
export function playCityArrival(engine, onComplete, { fromOpeningVideo = false } = {}) {
  const camera=engine.get('camera'), player=engine.player;
  if(!camera?.cinematic || !player) { onComplete(); return; }
  engine.state.mode='paused';engine.state.frozen=true;engine.state.arrival=true;
  const enabled=engine.input.enabled;engine.input.enabled=false;
  document.exitPointerLock?.();
  camera.mode='follow';camera.fixed=null;camera._hold=null;camera._blend=null;
  camera.combat=false;camera.yaw=player.yaw;camera.lookAccum.set(0,0);camera.initialised=false;
  camera.updateFollow(1/60);
  const end=camera.cam.position.clone(), target=player.position.clone(), fov=camera.cam.fov;
  target.y+=1.2;
  const endTarget=camera.cam.getWorldDirection(end.clone()).multiplyScalar(4).add(end);
  // Start at the close crossing view (about 7 s into the published v2 recording).
  // The former 650 m establishing shot exposed unfinished outskirts; omit it.
  // Reference direction: SHIBUYA SKY looking NW (YouTube 4ffe7JI3zSs).
  const crossingTarget=target.clone().set(-4,player.position.y,-2);
  const skyView=target.clone().set(100,player.position.y+229,85);
  const root=document.createElement('section');root.id='city-arrival';root.setAttribute('aria-label','渋谷上空から渋沢へ');
  root.innerHTML='<div class="arrival-title"><small>第一章</small><h1>十年ぶりの渋谷</h1><p>渋谷町 — ハチ公前へ</p></div><button type="button">スキップ <span>Esc</span></button>';
  const style=document.createElement('style');style.textContent='#city-arrival{position:fixed;inset:0;z-index:100;box-shadow:inset 0 55px #000,inset 0 -55px #000;color:#fff;pointer-events:auto}body.arrival-playing #hud{visibility:hidden}.arrival-title{position:absolute;left:7%;top:15%;text-shadow:0 2px 10px #000;font-family:serif;animation:arrival-title 7.5s both}.arrival-title small{letter-spacing:.5em}.arrival-title h1{font-size:clamp(24px,4vw,48px);letter-spacing:.18em}.arrival-title p{letter-spacing:.2em}#city-arrival button{position:absolute;right:4%;bottom:16px;color:#ddd;background:#111;border:1px solid #88795e;padding:10px 18px;cursor:pointer}@keyframes arrival-title{0%{opacity:0}15%,55%{opacity:1}85%,100%{opacity:0}}';
  document.head.append(style);document.body.append(root);document.body.classList.add('arrival-playing');
  let finished=false,frame;
  const finish=()=>{if(finished)return;finished=true;cancelAnimationFrame(frame);window.removeEventListener('keydown',key,true);root.remove();style.remove();document.body.classList.remove('arrival-playing');engine.input.enabled=enabled;engine.state.arrival=false;onComplete();};
  const skip=()=>{camera.stopCinematic();camera.mode='follow';camera._blend=null;camera.initialised=false;camera.updateFollow(1/60);finish();};
  const key=e=>{e.stopImmediatePropagation();e.preventDefault();if(e.key==='Escape')skip();};
  window.addEventListener('keydown',key,true);
  for(const event of ['pointerdown','pointerup','mousedown','mouseup'])root.addEventListener(event,e=>e.stopPropagation());
  root.querySelector('button').onclick=skip;
  if (fromOpeningVideo) {
    // The approved movie has already descended. Reveal the real follow camera once,
    // without flying over unfinished city blocks for a second time.
    root.dataset.arrival = 'ground-handoff';
    root.querySelector('.arrival-title').style.animationDuration = '2.4s';
    let elapsed = 0, previous = performance.now();
    const reveal = now => {
      if (finished) return;
      if (!document.hidden) elapsed += Math.min((now - previous) / 1000, .1);
      previous = now;
      root.style.backgroundColor = `rgba(0,0,0,${Math.max(0, 1 - elapsed / .65)})`;
      if (elapsed >= 2.4) { finish(); return; }
      frame = requestAnimationFrame(reveal);
    };
    root.style.backgroundColor = '#000';
    frame = requestAnimationFrame(reveal);
    return { finish: skip };
  }
  camera.cinematic({collide:false,blendOut:.65,
    pos:skyView,lookAt:crossingTarget,fov:44,duration:8,cut:true,curve:'arrival',
    to:{pos:end,lookAt:endTarget,fov},
  }).then(()=>{
    if(finished)return;
    const handoff=()=>{if(finished)return;if(camera._blend){frame=requestAnimationFrame(handoff);return;}finish();};handoff();
  });
  return {finish:skip};
}
