const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyCollection, sanitizeCollection, awardFish } = require('../main/collection');
const catalog = require('../renderer/fish/fish.json');
function fixture() { return { settings: {goalMl:1500}, today:{dayKey:'2026-10-17',entries:[{ml:1500}]},collection:emptyCollection() }; }
test('first full day is clownfish; undo/refill and reload cannot award twice', () => {
  const d=fixture();
  assert.equal(awardFish(d,catalog,()=>0.5).id,'clown');
  d.today.entries=[];
  assert.equal(awardFish(d,catalog),null);
  d.today.entries=[{ml:1500}];
  d.collection=sanitizeCollection(JSON.parse(JSON.stringify(d.collection)),catalog);
  assert.equal(awardFish(d,catalog),null);
  assert.equal(d.collection.fish.clown.count,1);
});
test('uncollected species precede repeats; maximum and first date persist', () => {
  const d=fixture(); const ids=[];
  for(let n=0;n<5;n++) { d.today.dayKey=`2026-10-${17+n}`;ids.push(awardFish(d,catalog,()=>0).id); }
  assert.equal(new Set(ids).size,5);
  d.today.dayKey='2026-10-22';
  assert.equal(awardFish(d,catalog,()=>0).id,'clown');
  assert.equal(d.collection.fish.clown.count,2);
  assert.equal(d.collection.fish.clown.firstSeen,'2026-10-17');
  d.today.dayKey='2026-10-23';
  let calls=0;const arrival=awardFish(d,catalog,()=>calls++===0?0:0.99);
  assert.ok(arrival.cm>=8&&arrival.cm<=11);
  assert.equal(d.collection.fish.clown.maxCm,arrival.cm);
});
test('below goal never awards; old data gains empty collection',()=>{
  const d=fixture();d.today.entries=[{ml:1499}];
  assert.equal(awardFish(d,catalog),null);
  assert.deepEqual(sanitizeCollection(undefined,catalog),emptyCollection());
  assert.deepEqual(sanitizeCollection({fish:{clown:{count:-1}}},catalog).fish,{});
});
