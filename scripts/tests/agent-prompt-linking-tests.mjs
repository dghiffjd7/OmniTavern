import assert from 'node:assert/strict';
import { chooseAgentPromptScrollAnchor } from '../../src/scripts/ui/chat/agent-prompt-navigation-model.js';
import { mapPromptSelection, promptLineOffsets, promptSelectionOffsets, promptSelectionRanges } from '../../src/scripts/ui/chat/agent-prompt-selection-model.js';
import { createAgentPromptDiffCache, renderAgentPromptDiff } from '../../src/scripts/ui/chat/agent-prompt-diff.js';

const rows=[{key:'guide',top:0,bottom:900},
  {key:'first',parentKey:'guide',top:10,bottom:25},
  {key:'next',parentKey:'guide',top:80,bottom:100},
  {key:'last',parentKey:'guide',top:800,bottom:825},
  {key:'external',top:950,bottom:1200}];
for(const y of [0,12,30,55,79])assert.equal(chooseAgentPromptScrollAnchor(rows,y)?.key,'first');
for(const y of [100,200,600,799])assert.equal(chooseAgentPromptScrollAnchor(rows,y)?.key,'next');
assert.equal(chooseAgentPromptScrollAnchor(rows,805,'next').key,'next');
assert.equal(chooseAgentPromptScrollAnchor(rows,811,'next').key,'last');
assert.equal(chooseAgentPromptScrollAnchor(rows,796,'last').key,'last');
assert.equal(chooseAgentPromptScrollAnchor(rows,780,'last').key,'next');
assert.equal(chooseAgentPromptScrollAnchor(rows,1050).key,'external');
assert.equal(chooseAgentPromptScrollAnchor([],0),null);
console.log('PASS whitespace follows its owned field, boundary hysteresis prevents parent/child oscillation');

assert.deepEqual(promptLineOffsets('甲\n\n乙\n'),[0,2,3,5]);
assert.deepEqual(mapPromptSelection(' \nhello \n','hello',3,6),{start:1,end:4});
assert.deepEqual(mapPromptSelection('hello',' \nhello \n',1,4),{start:3,end:6});
assert.equal(mapPromptSelection('{{tableData}}','real values',0,5),null);
assert.equal(mapPromptSelection(' hello ','hello',0,1),null);
assert.equal(mapPromptSelection('one same','two same',4,8),null,'repeated text in another source is not a mapping');
const diff=createAgentPromptDiffCache().get({id:'prompt',baseValue:'old\nkeep\nlast',value:'new\nkeep\n'});
const html=renderAgentPromptDiff(diff,'prompt');
assert(html.includes('data-prompt-base-length="13"') && html.includes('data-prompt-draft-length="9"'));
assert(html.includes('data-prompt-base-start="0" data-prompt-base-end="3"'));
assert(html.includes('data-prompt-draft-start="0" data-prompt-draft-end="3"'));
assert(html.includes('data-prompt-draft-start="9" data-prompt-draft-end="9"'),'blank lines keep real zero-length text offsets');
const a={data:'new'},b={data:'keep'},index={segments:[{node:a,start:0,end:3},{node:b,start:4,end:8}]};
const range={startContainer:a,startOffset:1,endContainer:b,endOffset:2,intersectsNode:()=>true};
assert.deepEqual(promptSelectionOffsets(index,range),{start:1,end:6});
const doc={createRange:()=>({setStart(node,offset){this.start=[node,offset];},setEnd(node,offset){this.end=[node,offset];}})};
const ranges=promptSelectionRanges(index,1,6,doc);
assert.deepEqual(ranges.map(r=>[r.start,r.end]),[[[a,1],[a,3]],[[b,0],[b,2]]]);
console.log('PASS selection offsets preserve Unicode/blank lines and omit diff deletions/actions from the live text');
