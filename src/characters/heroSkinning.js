// Meshy capsule weights leaked thigh influence far down the calf. Use a compact
// knee blend so trouser volume follows the shin instead of folding back into the thigh.
export function fitHeroKnees(geo, rig) {
  const p=geo.getAttribute('position');
  const si=geo.getAttribute('skinIndex').clone(), sw=geo.getAttribute('skinWeight').clone();
  const smooth=(a,b,v)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t);};
  for(let i=0;i<p.count;i++){
    const y=p.getY(i);if(y<=.24||y>=.80)continue;
    // Long fingers can extend below the jacket hem: height alone isn't a leg mask.
    let legWeight=0;
    for(let k=0;k<4;k++)if(/(?:UpLeg|Leg|Foot|ToeBase)$/.test(rig.names[si.getComponent(i,k)]))legWeight+=sw.getComponent(i,k);
    if(legWeight<.95)continue;
    const side=p.getX(i)>=0?'Left':'Right';
    const thigh=rig.index[side+'UpLeg'],shin=rig.index[side+'Leg'];
    const knee=rig.joints[side+'Leg'][1],u=smooth(knee-.085,knee+.085,y);
    const blend=smooth(.24,.30,y)*(1-smooth(.74,.80,y));
    const weights=new Map();
    for(let k=0;k<4;k++){const b=si.getComponent(i,k);weights.set(b,(weights.get(b)||0)+sw.getComponent(i,k)*(1-blend));}
    weights.set(thigh,(weights.get(thigh)||0)+blend*u);
    weights.set(shin,(weights.get(shin)||0)+blend*(1-u));
    const top=[...weights].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((n,w)=>n+w[1],0);
    for(let k=0;k<4;k++){si.setComponent(i,k,top[k]?.[0]||0);sw.setComponent(i,k,(top[k]?.[1]||0)/sum);}
  }
  geo.setAttribute('skinIndex',si);geo.setAttribute('skinWeight',sw);
}
