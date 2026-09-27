// Fictional Genna-kai office on the north frontage at the back of Center Gai.
// The entry and actor marks share a local frame: +Z points out into the street.
export const BRANCH = { door: [-151.66, -93.64], outward: [-11 / Math.hypot(11,26), 26 / Math.hypot(11,26)] };
export function installBranchOffice(m, T) {
  const n=new T.Vector3(BRANCH.outward[0],0,BRANCH.outward[1]);
  const side=new T.Vector3(n.z,0,-n.x);
  const origin=new T.Vector3(BRANCH.door[0],0,BRANCH.door[1]);
  m.branchMark=(across=0,out=0)=>origin.clone().addScaledVector(n,out).addScaledVector(side,across);
  m.ensureBranchOffice=()=>{
    if(m.branchOffice || !m.engine.scene)return;
    // Snap the visual entrance to the actual generated frontage, which can protrude
    // beyond the block polygon. Avoid placing the sign inside the existing shop shell.
    m.engine.scene.updateMatrixWorld(true);
    const rayStart=m.branchMark(0,7);rayStart.y=m.groundAt(rayStart.x,rayStart.z)+1.6;
    const ray=new T.Raycaster(rayStart,n.clone().negate(),.1,10);
    const surfaces=[];m.engine.scene.traverse(o=>{if(o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh && o.visible)surfaces.push(o);});
    const hit=ray.intersectObjects(surfaces,false).find(h=>{
      if(!h.face || h.object.isSkinnedMesh)return false;
      const normal=h.face.normal.clone().transformDirection(h.object.matrixWorld);
      return normal.dot(n)>.65;
    });
    if(hit){origin.copy(hit.point).addScaledVector(n,.16).setY(0);}
    const root=new T.Group();root.name='genna-kai-shibuya-office';
    root.position.copy(m.branchMark());root.position.y=m.groundAt(root.position.x,root.position.z);
    root.rotation.y=Math.atan2(n.x,n.z);
    const dark=new T.MeshStandardMaterial({color:0x10151c,roughness:.4,metalness:.65});
    const trim=new T.MeshStandardMaterial({color:0x777367,roughness:.32,metalness:.75});
    const box=(w,h,d,x,y,z,mat)=>{const mesh=new T.Mesh(new T.BoxGeometry(w,h,d),mat);mesh.position.set(x,y,z);root.add(mesh);return mesh;};
    box(2.5,3.1,.16,0,1.55,0,dark);
    const door=box(1.95,2.65,.08,0,1.34,.12,dark);
    box(.08,2.85,.2,-1.06,1.43,.17,trim);box(.08,2.85,.2,1.06,1.43,.17,trim);box(2.2,.08,.2,0,2.86,.17,trim);
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=192;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#10151c';ctx.fillRect(0,0,1024,192);
    ctx.fillStyle='#e2d4ad';ctx.textAlign='center';ctx.font='600 68px serif';ctx.fillText('玄凪会',512,82);ctx.font='32px sans-serif';ctx.fillText('渋谷支社',512,143);
    const tex=new T.CanvasTexture(canvas);tex.colorSpace=T.SRGBColorSpace;
    box(3,.57,.09,0,3.25,.15,new T.MeshBasicMaterial({map:tex}));
    m.engine.scene.add(root);m.branchOffice={root,door};
    for(const step of [8,10])m.STEPS[step]?.pos?.copy(m.branchMark(0,3));
    if([8,10].includes(m.index))m.setStep(m.index);
  };
  m.stageBranch=()=>{
    m.ensureBranchOffice();
    const at=m.branchMark(3,3.1), target=m.branchMark(0,1.9);
    m.engine.get('player').respawn(at,Math.atan2(target.x-at.x,target.z-at.z));
    m.dropBriefcase();
  };
  m.branchEntranceShot=()=>{
    const pos=m.branchMark(4,6),look=m.branchMark(0,1);
    pos.y=m.groundAt(pos.x,pos.z)+2;look.y=m.groundAt(look.x,look.z)+1.5;
    return {pos:pos.toArray(),lookAt:look.toArray(),fov:46};
  };
  m.resetBranchEntrance=()=>{
    m._hiiragiWalk=null;
    if(m.branchOffice)m.branchOffice.door.position.x=0;
  };
  m.updateChapterActors=dt=>{
    if(m.engine.player.position.distanceTo(m.branchMark())<85)m.ensureBranchOffice();
    const walk=m._hiiragiWalk;if(!walk)return;
    walk.t=Math.min(2.4,walk.t+dt);
    const at=m.branchMark(0,.25+walk.t*.85);at.y=m.groundAt(at.x,at.z);
    walk.actor.pos.copy(at);
    walk.actor.h.group.rotation.y=Math.atan2(n.x,n.z);
    if(m.branchOffice)m.branchOffice.door.position.x=Math.min(1,walk.t*2)*2.05;
    if(walk.t>=2.4){walk.actor.h.play?.('idle',{fade:.3});m._hiiragiWalk=null;}
  };
}
