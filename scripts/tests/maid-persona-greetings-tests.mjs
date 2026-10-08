import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppContentAgentTools} from '../../src/scripts/agent/tools/app-content-tools.js';
import {createAppResourceReader} from '../../src/scripts/agent/app-resource-reader.js';
import {normalizeCharacterCard} from '../../src/scripts/utils/character-card.js';
import {buildTavernV2CharacterCard} from '../../src/scripts/utils/character-card-export.js';

test('create, read and export persist three actual greetings; a duplicate name does not overwrite them',async()=>{
 const cards=[];const store={getAll:()=>cards,getActive:()=>cards[0],create:async data=>{const card={...data,id:'new-card'};cards.push(card);return card;}};
 const tool=createAppContentAgentTools({personaStore:store}).find(t=>t.name==='persona.create');
 const greetings=['雨夜，刺客停下脚步。','暗巷里传来低语。','门缝下滑进一张纸条。'];
 const made=await tool.execute({name:'夜羽',description:'冷酷刺客',greetings});
 assert.equal(made.created,true);assert.deepEqual(made.greetings,greetings);
 const normalized=normalizeCharacterCard(cards[0].originalCard);
 assert.equal(normalized.first_mes,greetings[0]);assert.deepEqual(normalized.alternate_greetings,greetings.slice(1));
 const read=await createAppResourceReader({personaStore:store})({resource:'persona',id:'new-card',include:['greetings']});
 assert.deepEqual(read.items[0].greetings,greetings);
 const exported=buildTavernV2CharacterCard({persona:cards[0],rawCard:cards[0].originalCard});
 assert.deepEqual([exported.data.first_mes,...exported.data.alternate_greetings],greetings);
 const duplicate=await tool.execute({name:'夜羽',greetings:['不可覆盖']});
 assert.equal(duplicate.created,false);assert.deepEqual(duplicate.greetings,greetings);assert.equal(cards.length,1);
});
