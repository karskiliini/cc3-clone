import {Battle} from '@/sim/battle';
import {addMessage} from '@/sim/messages';
/** Reproducible live test. Opponent is human-controlled and readied, not an omniscient demo bot. */
export function createTelephoneExperiment():Battle{
 const b=new Battle({mapId:'telephone_experiment',playerSide:'german',year:1942,seed:76077,durationS:1200,difficulty:'normal',controllers:{german:'human',soviet:'human'},neverActOnInitiative:true,alwaysObeyOrders:true,airSupport:false,artillerySupport:{german:{shells:48},soviet:{shells:12}},telephoneWireStockM:1000,
 forces:{german:['ger_rifle_41','ger_rifle_41','ger_rifle_41','ger_command','ger_mortar81'],soviet:['sov_t34_76','sov_command']}});
 const g=b.selectableTeams('german').filter(t=>t.supportForTeamId==null),s=b.selectableTeams('soviet');
 const positions=[{x:54,y:40},{x:10,y:40},{x:10,y:46},{x:10,y:14},{x:16,y:46}];
 const names=['I Platoon — observing','II Platoon — telephone','Receiving squad','Radio HQ','Organic mortar'];
 for(let i=0;i<g.length;i++){b.submit('german',{type:'deployTeam',teamId:g[i].id,pos:positions[i]});g[i].name=names[i];}
 const tank=s.find(t=>t.vehicleId!=null)!,hq=s.find(t=>t.type==='command')!;
 b.submit('soviet',{type:'deployTeam',teamId:tank.id,pos:{x:76,y:28}});b.submit('soviet',{type:'deployTeam',teamId:hq.id,pos:{x:72,y:4}});b.step(0);
 const a=b.state.soldiers.get(g[0].leaderId)!,z=b.state.soldiers.get(g[1].leaderId)!;
 b.submit('german',{type:'connectTelephone',fromTeamId:g[0].id,toTeamId:g[1].id,points:[{...a.pos},{x:54,y:6},{x:10,y:6},{...z.pos}],underground:false});b.step(0);
 // Safe training target: nobody is killed before the report can be inspected.
 for(const v of b.state.vehicles.values())if(v.side==='soviet'){v.mainAmmo=0;v.coaxAmmo=0;v.bowAmmo=0;v.rounds={ap:0,he:0,apcr:0,smoke:0};v.loadedRound=undefined;}
 for(const man of b.state.soldiers.values())if(man.side==='german'){man.morale=100;man.experience=95;man.mind.motivation=100;man.mind.trait='brave';}
 for(const man of b.state.soldiers.values())if(man.side==='soviet'){man.ammo=0;man.ammoReserve=0;man.grenades=0;}
 addMessage(b.state,'SIGNAL EXPERIMENT: press Begin. I Platoon sees the unarmed T-34; II Platoon and Receiving squad are behind the warehouse. Select Receiving squad to inspect its reported contact.','info','german');
 addMessage(b.state,'The routed telephone is already laid. Gold = exposed wire; cyan = protected urban segment. FIELD TELEPHONE opens line status. RADIO opens both radio nets and own phone transcript. Signal buttons exercise the HQ radio.','info','german');
 b.submit('soviet',{type:'ready'});b.step(0);b.submit('soviet',{type:'signal',signal:2},60);return b;
}
