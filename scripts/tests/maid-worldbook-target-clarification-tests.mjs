import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { applyMaidResultPresentation } from '../../src/scripts/agent/maid-result-presentation.js';
import { classifyMaidOperationIntent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/maid-worldbook-target-clarification-D10.json', import.meta.url), 'utf8'));
const registry = createAgentToolRegistry();
registry.registerMany(createAppNavigationAgentTools({}));
registry.registerMany(createAppContentAgentTools({}));
const fresh = () => structuredClone(captured);
const present = fixture => applyMaidResultPresentation(fixture.result, {
  input: fixture.input,
  context: { ...fixture.context, operationIntentPolicy: classifyMaidOperationIntent(fixture.input) },
  isWriteTool: name => registry.get(name)?.capabilities?.write,
});
const worldStep = fixture => fixture.result.steps.find(step => step.args?.resource === 'worldbook');
const worldOutput = fixture => worldStep(fixture).output;
const matchedBook = fixture => worldOutput(fixture).worldbooks.find(book => book.entries.length);
const unchanged = fixture => assert.strictEqual(present(fixture), fixture.result);

test('captured D10 DeepSeek clarify renders the verified unbound state and options with APP attribution', () => {
  // The production classifier does not currently recognize "补一句" as a
  // write intent. Presentation eligibility must not invent write_allowed.
  assert.equal(classifyMaidOperationIntent(captured.input).mode, 'unspecified');
  const fixture = fresh(), original = JSON.stringify(fixture.result), actual = present(fixture);
  assert.equal(actual.appPresentation?.kind, 'worldbook_target_clarification');
  assert.equal(actual.appPresentation.source, 'app');
  assert.match(actual.message, /APP/);
  assert.match(actual.message, /尚未绑定世界书/);
  assert.match(actual.message, /邻家篇世界书/);
  assert.match(actual.message, /新建并绑定世界书/);
  assert.match(actual.message, /尚未写入/);
  assert.equal(actual.appPresentation.modelMessage, fixture.result.message);
  assert.equal(actual.appPresentation.requestRoleCardId, fixture.context.roleCardId);
  assert.equal(actual.appPresentation.requestRunId, fixture.context.submissionId);
  assert.equal(actual.appPresentation.evidence.entry.id, 'other_01');
  assert.equal(actual.appPresentation.evidence.currentCard.bindingState, 'unbound');
  assert.strictEqual(actual.finalDecision, fixture.result.finalDecision);
  assert.equal(JSON.stringify(fixture.result), original);
  assert.strictEqual(applyMaidResultPresentation(actual, {
    input: fixture.input, context: fixture.context, isWriteTool: name => registry.get(name)?.capabilities?.write,
  }), actual);
});

test('the D09 setting-addition request uses the same observed scope without changing any original draft', () => {
  // This is an offline related-request check using the real D10 ownership
  // snapshot, not a newly executed D09 model sample.
  for (const input of [
    '帮我在世界书里给林念初补一段她妈妈的设定，温柔但管得很严',
    '请修改世界书中林念初的设定，添加她喜欢看书的习惯',
  ]) {
    const fixture = fresh(); fixture.input = input;
    const result = present(fixture);
    assert.equal(result.appPresentation?.kind, 'worldbook_target_clarification');
    assert.strictEqual(result.finalDecision, fixture.result.finalDecision);
    assert.equal(result.appPresentation.modelMessage, fixture.result.message);
  }
});

test('incidental lore reads cannot replace contact, merge, creation, deletion or other compound requests', () => {
  for (const input of [
    '新建林念初联系人，参考她的设定补一句很怕打雷',
    '合并含林念初的两本世界书，并补充设定',
    '比较林念初和另一人的设定，修改不同的部分',
    '给林念初新建一本世界书，再补充设定',
    '删除林念初的世界书条目，再添加设定',
    '补充林念初的设定，然后打开世界书',
    '修改林念初的设定，顺便发条动态',
    '只读查看林念初的设定，不要修改',
    '修改林念初的设定，算了',
  ]) { const fixture = fresh(); fixture.input = input; unchanged(fixture); }
});

test('only explicit FC clarify and the current successful read-only request may change presentation', () => {
  for (const mutate of [
    f => { delete f.result.finalDecision.providerFcControl; },
    f => { f.result.finalDecision.providerFcControl = 'final'; },
    f => { f.result.finalDecision.source = 'model_react'; },
    f => { f.result.finalDecision.ok = false; },
    f => { f.result.status = 'interrupted'; },
    f => { f.context.signal = { aborted: true }; },
    f => { delete f.context.roleCardId; },
    f => { delete f.context.submissionId; },
    f => { f.context.roleCardId = 'different-card'; },
    f => { f.context.runContinuation = {}; },
    f => { f.result.steps[0].metadata = { submissionId: 'another-request' }; },
    f => { f.result.steps[0].output.ok = false; },
    f => { f.result.steps[0].output.partial = true; },
    f => { f.result.steps[0].toolName = 'unknown.tool'; },
    f => { f.result.steps.push({ toolName: 'worldbook.update_entries', status: 'succeeded', output: { ok: true } }); },
    f => { f.input = '只读查看林念初的设定，不要修改'; },
  ]) { const fixture = fresh(); mutate(fixture); unchanged(fixture); }
});

test('incomplete, non-unique and inconsistent ownership evidence cannot become a target question', () => {
  for (const mutate of [
    f => { worldOutput(f).count += 1; },
    f => { delete worldOutput(f).count; },
    f => { matchedBook(f).truncated = true; },
    f => { matchedBook(f).returnedEntryCount += 1; },
    f => { const b = matchedBook(f); b.entries.push({ ...b.entries[0], id: 'other_02' }); b.returnedEntryCount += 1; },
    f => { const b = matchedBook(f); const other = structuredClone(b); other.id = 'another-book'; worldOutput(f).worldbooks.push(other); worldOutput(f).count += 1; },
    f => { matchedBook(f).ownershipKnown = false; },
    f => { matchedBook(f).targetSelectionEvidence.currentCard.bindingState = 'unknown'; },
    f => { matchedBook(f).targetSelectionEvidence.currentCard.worldbookId = 'already-bound'; },
    f => { matchedBook(f).targetSelectionEvidence.currentCard.personaId = 'different-card'; },
    f => { worldOutput(f).worldbooks[0].targetSelectionEvidence.currentCard.bindingState = 'bound'; },
    f => { matchedBook(f).currentCard = true; },
    f => { matchedBook(f).personaBindings[0].personaId = f.context.roleCardId; },
    f => { matchedBook(f).targetSelectionEvidence.observedWorldbook.worldbookId = 'different'; },
    f => { matchedBook(f).targetSelectionEvidence.targetOptions[0].intent = 'use_current_binding'; },
    f => { matchedBook(f).targetSelectionEvidence.targetOptions[1].worldbookId = 'different'; },
    f => { matchedBook(f).targetSelectionEvidence.targetOptions.pop(); },
    f => { worldOutput(f).sessionLookup.matched = false; },
    f => { worldStep(f).args.query = 'someone-unread'; },
    f => { delete worldStep(f).args.query; },
  ]) { const fixture = fresh(); mutate(fixture); unchanged(fixture); }
  for (const selector of ['id', 'name', 'worldbookId', 'worldbookName', 'sessionId', 'sessionName', 'target', 'chatName', 'scope']) {
    const fixture = fresh(); worldStep(fixture).args[selector] = 'scoped-target'; unchanged(fixture);
  }
});

test('explicit book or owner choices and single-book reads pass through without an extra target choice', () => {
  for (const named of ['邻家篇世界书', '邻家篇', '林念初以外的人']) {
    const fixture = fresh();
    fixture.input = named === '林念初以外的人' ? '给未读人物补一句怕打雷' : `在${named}里给林念初补一句怕打雷`;
    unchanged(fixture);
  }
  const fixture = fresh(), step = worldStep(fixture), book = matchedBook(fixture), currentCard = worldOutput(fixture).currentCard;
  step.toolName = 'worldbook.read'; step.args = { id: book.id, query: '林念初' };
  step.output = { ok: true, ...book, currentCard };
  unchanged(fixture);
});

test('generic keywords cannot stand in for explicit entry identity in the user request', () => {
  const fixture = fresh(), entry = matchedBook(fixture).entries[0];
  entry.id = 'different-person'; entry.title = '另一个人'; entry.keys = ['她'];
  worldStep(fixture).args.query = '她';
  unchanged(fixture);
});

test('knowledge questions and hypothetical edits keep the original answer instead of a target choice', () => {
  const outcomes = ['林念初的设定为什么修改？', '如果修改林念初的设定，会发生什么'].map(input => {
    const fixture = fresh(); fixture.input = input;
    return present(fixture) === fixture.result;
  });
  assert.deepEqual(outcomes, [true, true]);
});

test('later contradictory reads cannot reuse earlier ownership; equivalent reads retain their actual latest source', () => {
  const fixture = fresh(), repeated = structuredClone(worldStep(fixture));
  repeated.index += 1; fixture.result.steps.push(repeated);
  const result = present(fixture);
  assert.equal(result.appPresentation?.evidence.sourceStepIndex, 3);
  assert.equal(result.appPresentation.evidence.sourceStep, repeated.index);
  const changed = repeated.output.worldbooks.find(book => book.entries.length);
  for (const binding of [changed.personaBindings[0], changed.targetSelectionEvidence.observedWorldbook.personaBindings[0]]) {
    binding.personaId = 'another-owner'; binding.personaName = '另一张卡';
  }
  changed.ownerCards = ['另一张卡']; changed.otherOwnerCards = ['另一张卡'];
  unchanged(fixture);
});

test('dynamic labels are bounded single-line plain text while exact source identities remain in evidence', () => {
  const fixture = fresh(), output = worldOutput(fixture), book = matchedBook(fixture);
  const hostile = '**name**\n[go](https://example.test) <script>bad</script> ' + 'long '.repeat(25);
  output.currentCard.personaName = hostile;
  for (const candidate of output.worldbooks) candidate.targetSelectionEvidence.currentCard.personaName = hostile;
  book.name = hostile; book.entries[0].title = hostile;
  for (const binding of [book.personaBindings[0], book.targetSelectionEvidence.observedWorldbook.personaBindings[0]]) binding.personaName = hostile;
  book.ownerCards = [hostile]; book.otherOwnerCards = [hostile];
  // Identify the observed entry by its real stable ID after changing its
  // display title; a generic keyword must not manufacture this identity.
  fixture.input = `给 ${book.entries[0].id} 的设定补一句她怕打雷`;
  delete worldStep(fixture).args.query;
  worldStep(fixture).args.entryId = book.entries[0].id;
  const actual = present(fixture);
  assert.equal(actual.appPresentation?.kind, 'worldbook_target_clarification');
  assert.equal(actual.message.split('\n').length, 4);
  assert(!actual.message.includes('**name**'));
  assert(!actual.message.includes('[go]('));
  assert(!actual.message.includes('<script>'));
  assert(actual.message.length < 2200);
  assert.equal(actual.appPresentation.evidence.observedWorldbook.name, hostile);
  assert.equal(actual.appPresentation.evidence.entry.title, hostile);
});
