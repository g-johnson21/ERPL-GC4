/**
 * Tests for the Data page's layout model.
 *
 *   node --test public/js/data-layout.test.js
 *
 * The one property that matters most is that no edit, and no config change
 * under a saved layout, can leave a channel off the page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultLayout, reconcile, moveItem, removeItem, setItemSize, setPanelSize, setPanelCols,
  movePanel, addPanel, removePanel, ensurePanel, setLaneWidth, setLaneWidths, setLaneFill, resizePair, placements, splitColumns, panelExtent,
  reconcilePresets, activePreset, setActiveLayout, selectPreset, addPreset, renamePreset, removePreset, MAX_PRESETS,
} from './data-layout.js';

const groups = [
  { id: 'lox', sensors: [{ id: 'PT1' }, { id: 'PT2' }, { id: 'PT3' }] },
  { id: 'fuel', sensors: [{ id: 'PT4' }, { id: 'PT5' }] },
  { id: 'tc', sensors: [{ id: 'TC1' }, { id: 'TC2' }, { id: 'TC3' }, { id: 'TC4' }] },
];
const allIds = groups.flatMap((g) => g.sensors.map((s) => s.id));

function everyChannelPlaced(layout, ids = allIds) {
  for (const id of ids) assert.ok(placements(layout, id) >= 1, `${id} is on the page`);
  const inLanes = new Set(layout.lanes.flatMap((l) => l.panels));
  for (const pid of Object.keys(layout.panels)) assert.ok(inLanes.has(pid), `${pid} is in a lane`);
}

test('the default is one lane per group, every channel a card', () => {
  const L = defaultLayout(groups);
  assert.equal(L.lanes.length, 3);
  assert.deepEqual(L.panels['g:lox'].items.map((i) => i.id), ['PT1', 'PT2', 'PT3']);
  assert.equal(L.panels['g:tc'].size, 'card');
  everyChannelPlaced(L);
});

test('garbage and old versions fall back to the default', () => {
  for (const bad of [null, 'x', {}, { v: 99, lanes: [], panels: {} }, { v: 1, lanes: 'no', panels: {} }]) {
    assert.deepEqual(reconcile(bad, groups), defaultLayout(groups));
  }
});

test('reconcile drops vanished channels and groups, and places new ones', () => {
  const L = defaultLayout(groups);
  L.panels['g:lox'].items.push({ id: 'GONE' });
  const next = [
    { id: 'lox', sensors: [{ id: 'PT1' }, { id: 'PT0' }, { id: 'PT2' }, { id: 'PT3' }] },
    { id: 'fuel', sensors: [{ id: 'PT4' }, { id: 'PT5' }] },
    { id: 'gn2', sensors: [{ id: 'PT9' }] },
  ];
  const R = reconcile(L, next);
  assert.deepEqual(R.panels['g:lox'].items.map((i) => i.id), ['PT1', 'PT0', 'PT2', 'PT3'], 'new channel lands in config order');
  assert.equal(R.panels['g:tc'], undefined);
  assert.ok(R.panels['g:gn2'], 'a new group gets a panel');
  assert.equal(R.lanes.length, 3);
  everyChannelPlaced(R, ['PT0', 'PT1', 'PT2', 'PT3', 'PT4', 'PT5', 'PT9']);
});

test('moving a channel to another panel takes it out of the first', () => {
  let L = defaultLayout(groups);
  L = moveItem(L, groups, { sensorId: 'PT5', fromPanel: 'g:fuel', toPanel: 'g:lox', beforeId: 'PT2' });
  assert.deepEqual(L.panels['g:lox'].items.map((i) => i.id), ['PT1', 'PT5', 'PT2', 'PT3']);
  assert.deepEqual(L.panels['g:fuel'].items.map((i) => i.id), ['PT4']);
  everyChannelPlaced(L);
});

test('reordering within a panel', () => {
  let L = defaultLayout(groups);
  L = moveItem(L, groups, { sensorId: 'PT3', fromPanel: 'g:lox', toPanel: 'g:lox', beforeId: 'PT1' });
  assert.deepEqual(L.panels['g:lox'].items.map((i) => i.id), ['PT3', 'PT1', 'PT2']);
  L = moveItem(L, groups, { sensorId: 'PT3', fromPanel: 'g:lox', toPanel: 'g:lox', beforeId: null });
  assert.deepEqual(L.panels['g:lox'].items.map((i) => i.id), ['PT1', 'PT2', 'PT3']);
});

test('copying to a watch panel keeps the original, and the copy can be removed', () => {
  let L = defaultLayout(groups);
  const made = ensurePanel(L, groups, 'Watch');
  L = made.layout;
  assert.equal(L.panels[made.id].size, 'large');
  assert.equal(L.lanes[0].panels[0], made.id, 'a new panel goes on the left');
  L = setItemSize(L, groups, 'g:lox', 'PT1', 'compact');
  L = moveItem(L, groups, { sensorId: 'PT1', fromPanel: 'g:lox', toPanel: made.id, copy: true });
  assert.equal(placements(L, 'PT1'), 2);
  assert.equal(L.panels[made.id].items[0].size, undefined, 'the copy takes the watch panel size');
  assert.equal(L.panels['g:lox'].items[0].size, 'compact');
  assert.equal(ensurePanel(L, groups, 'Watch').id, made.id, 'the same watch panel is reused');

  L = removeItem(L, groups, made.id, 'PT1');
  assert.equal(placements(L, 'PT1'), 1);
  // The last placement stays.
  assert.equal(removeItem(L, groups, 'g:lox', 'PT1'), L);
});

test('deleting a panel sends its only-placed channels home', () => {
  let { layout: L, id } = addPanel(defaultLayout(groups), groups, { title: 'Mine' });
  L = moveItem(L, groups, { sensorId: 'TC2', fromPanel: 'g:tc', toPanel: id });
  assert.equal(placements(L, 'TC2'), 1);
  L = removePanel(L, groups, id);
  assert.equal(L.panels[id], undefined);
  assert.ok(L.panels['g:tc'].items.some((i) => i.id === 'TC2'));
  everyChannelPlaced(L);
  assert.equal(removePanel(L, groups, 'g:tc'), L, "a group's own panel cannot be deleted");
});

test('stacking panels and splitting them back out', () => {
  let L = defaultLayout(groups);
  L = movePanel(L, groups, { panelId: 'g:fuel', toLane: 0 });
  assert.equal(L.lanes.length, 2, 'the emptied lane goes');
  assert.deepEqual(L.lanes[0].panels, ['g:lox', 'g:fuel']);
  L = movePanel(L, groups, { panelId: 'g:fuel', toLane: 0, beforeId: 'g:lox' });
  assert.deepEqual(L.lanes[0].panels, ['g:fuel', 'g:lox']);
  L = movePanel(L, groups, { panelId: 'g:fuel', newLaneAt: 2 });
  assert.deepEqual(L.lanes.map((l) => l.panels), [['g:lox'], ['g:tc'], ['g:fuel']]);
  everyChannelPlaced(L);
});

test('sizes, columns and widths are clamped', () => {
  let L = defaultLayout(groups);
  L = setPanelCols(L, groups, 'g:tc', 9);
  assert.equal(L.panels['g:tc'].cols, 3);
  L = setLaneWidth(L, groups, 0, 0);
  assert.equal(L.lanes[0].w, 1, 'nonsense falls back to 1');
  L = setLaneWidth(L, groups, 0, 1.23456);
  assert.equal(L.lanes[0].w, 1.23, 'fractional widths are kept, to 2 places');
  L = setLaneWidth(L, groups, 0, 99);
  assert.equal(L.lanes[0].w, 10);
  L = setItemSize(L, groups, 'g:tc', 'TC1', 'large');
  L = setPanelSize(L, groups, 'g:tc', 'compact');
  assert.equal(L.panels['g:tc'].items[0].size, undefined, 'panel size clears overrides');
  assert.equal(setItemSize(L, groups, 'g:tc', 'TC1', 'huge'), L);
});

test('columns balance by height, and compact panels do not grow', () => {
  const panel = { size: 'card', cols: 2, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] };
  assert.deepEqual(splitColumns(panel).map((c) => c.length), [2, 2]);
  const mixed = { size: 'compact', cols: 2, items: [{ id: 'a', size: 'large' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }] };
  const cols = splitColumns(mixed);
  assert.equal(cols[0].length, 1, 'the large card gets a column to itself');
  assert.equal(panelExtent({ size: 'compact', cols: 1, items: [{ id: 'a' }, { id: 'b' }] }, 20).grow, 0);
  const ext = panelExtent({ size: 'card', cols: 1, items: [{ id: 'a' }, { id: 'b' }] }, 20);
  assert.equal(ext.min, 20 + 84 * 2 + 6);
});

test('dragging a border moves only the two lanes beside it', () => {
  const [l, r] = resizePair(1, 1, 400, 400, 100);
  assert.equal(l, 1.25);
  assert.equal(r, 0.75);
  assert.equal(l + r, 2, 'their combined share is kept');
  assert.deepEqual(resizePair(1, 1, 400, 400, -1000, 120), [0.3, 1.7], 'held to the minimum width');
  let L = setLaneWidths(defaultLayout(groups), groups, [l, r]);
  assert.deepEqual(L.lanes.map((x) => x.w), [1.25, 0.75, 1]);
});

test('a fill lane has no height ceiling and stretches compact lines', () => {
  let L = setLaneFill(defaultLayout(groups), groups, 1, true);
  assert.equal(L.lanes[1].fill, true);
  assert.equal(reconcile(JSON.parse(JSON.stringify(L)), groups).lanes[1].fill, true, 'survives a save');
  L = setLaneFill(L, groups, 1, false);
  assert.equal('fill' in L.lanes[1], false);
  const compact = { size: 'compact', cols: 1, items: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(panelExtent(compact, 20, { fill: true }).grow, 0.7);
  assert.equal(panelExtent(compact, 20, { fill: true }).max, Infinity);
  assert.equal(panelExtent(compact, 20).grow, 0);
});

test('presets: the old single layout becomes Default, and junk is dropped', () => {
  const legacy = setLaneFill(defaultLayout(groups), groups, 0, true);
  const P = reconcilePresets(null, groups, legacy);
  assert.equal(P.list.length, 1);
  assert.equal(activePreset(P).name, 'Default');
  assert.equal(activePreset(P).layout.lanes[0].fill, true, 'the old layout is kept');
  const junk = reconcilePresets({ v: 1, active: 'zz', list: [null, { id: 'a', name: '  ' }, { id: 'a', name: 'dup' }] }, groups);
  assert.deepEqual(junk.list.map((p) => p.name), ['Layout 1'], 'a duplicate id is dropped and a blank name filled');
  assert.equal(junk.active, 'a', 'an unknown active falls back to the first');
  everyChannelPlaced(activePreset(junk).layout);
});

test('presets: add copies the screen, edits stay in their own preset', () => {
  let P = reconcilePresets(null, groups);
  P = addPreset(P, groups, { layout: setPanelCols(activePreset(P).layout, groups, 'g:tc', 2) });
  assert.equal(P.list.length, 2);
  assert.equal(activePreset(P).name, 'Layout 2');
  assert.equal(activePreset(P).layout.panels['g:tc'].cols, 2);
  P = setActiveLayout(P, setLaneFill(activePreset(P).layout, groups, 1, true));
  P = selectPreset(P, P.list[0].id);
  assert.equal(activePreset(P).layout.lanes[1].fill, undefined, 'the first preset is untouched');
  P = renamePreset(P, P.list[1].id, '  Hot   fire  ');
  assert.equal(P.list[1].name, 'Hot fire');
  assert.equal(renamePreset(P, P.list[1].id, '   '), P, 'a blank name is refused');
  const round = reconcilePresets(JSON.parse(JSON.stringify(P)), groups);
  assert.deepEqual(round, P, 'survives a save');
});

test('presets: delete shows a neighbour and keeps the last one; the count is capped', () => {
  let P = reconcilePresets(null, groups);
  P = addPreset(P, groups);
  P = addPreset(P, groups);
  const [a, b, c] = P.list.map((p) => p.id);
  P = selectPreset(P, b);
  P = removePreset(P, b);
  assert.equal(P.active, c);
  P = removePreset(removePreset(P, c), a);
  assert.equal(P.list.length, 1);
  assert.equal(removePreset(P, P.list[0].id), P, 'the last preset stays');
  while (P.list.length < MAX_PRESETS) P = addPreset(P, groups);
  assert.equal(addPreset(P, groups), P);
});
