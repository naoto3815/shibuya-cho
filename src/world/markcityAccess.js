// Separate elevated access decks; do not reshape neighbouring streets.
export const MARKCITY_VEHICLE_PATH=[[-362.2,188.6],[-350.4,196.1],[-340,196],[-320,195.5],[-300,195],[-278,195]];
export const MARKCITY_WALK_PATH=[[-338,190],[-328,187],[-300,187],[-278,187]];
export function accessHeight(x,z,base){
 const t=Math.max(0,Math.min(1,(x+340)/62));
 if(x>=-340&&x<=-278&&Math.abs(z-(196-t))<=3.5)return Math.max(base,15.377+3.6*t);
 if(x>=-328&&x<=-278&&Math.abs(z-187)<=1.5)return Math.max(base,16.2);
 return base;
}
