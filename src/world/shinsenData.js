// Public map coordinates projected into the city. Room 301 is a fictional game assignment.
export const HOME={name:'コーポエーデルワイス',room:'301',buildingIds:[136467369,136467359],door:[-669.146,180.98],approach:[-666.9,185.2]};
export const SHINSEN={west:[-647.6,250.5],gate:[-636,250],arrival:[-639,250],name:'神泉駅'};
// 渋谷: the foot of the 西口 stair + escalator up to the 中央口 (westDeck.js UP); arrival steps off beside it
export const SHIBUYA_RAIL={gate:[-45.2,100.3],arrival:[-43.6,101.4],name:'井の頭線 渋谷駅'};
export function canUseRail(state,player){return !!player&&state.mode==='explore'&&!state.frozen&&!player.riding&&player.alive!==false;}
