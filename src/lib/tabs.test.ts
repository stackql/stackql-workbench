import { describe, expect, it } from 'vitest';
import {
  activateTab,
  addTab,
  closeTab,
  restoreTabs,
  saveTabs,
  singleTab,
  stateOf,
  titleFor,
} from './tabs';

const start = () => stateOf(singleTab('SHOW PROVIDERS;'));

describe('titleFor', () => {
  it('names an empty tab by its number', () => {
    expect(titleFor('', 3)).toBe('Query 3');
    expect(titleFor('-- only a comment\n\n', 4)).toBe('Query 4');
  });

  it('uses the start of the first statement, on one line', () => {
    expect(titleFor('-- note\nSHOW   PROVIDERS;', 1)).toBe('SHOW PROVIDERS');
    const title = titleFor("SELECT login FROM github.orgs.orgs WHERE org = 'stackql';", 1);
    expect(title.length).toBeLessThanOrEqual(28);
    expect(title.endsWith('...')).toBe(true);
    expect(title.startsWith('SELECT login FROM')).toBe(true);
  });
});

describe('restoreTabs', () => {
  it('starts with one tab holding the fallback text', () => {
    const saved = restoreTabs(null, 'hello');
    expect(saved.tabs).toEqual([{ id: 'tab-1', title: 'Query 1', text: 'hello' }]);
    expect(saved.activeId).toBe('tab-1');
  });

  it('gives back what was saved', () => {
    let state = start();
    state = addTab(state, 'SELECT 1;').state;
    const texts: Record<string, string> = { 'tab-1': 'one', 'tab-2': 'two' };
    const saved = restoreTabs(
      saveTabs(state, (id) => texts[id] ?? ''),
      'unused',
    );
    expect(saved.tabs.map((t) => t.text)).toEqual(['one', 'two']);
    expect(saved.activeId).toBe('tab-2');
    expect(saved.next).toBe(3);
  });

  it('falls back to one tab when the saved value is damaged', () => {
    for (const bad of ['{ not json', 'null', '{}', '{"tabs":[]}', '{"tabs":[{"id":1}]}']) {
      expect(restoreTabs(bad, 'kept').tabs).toEqual([
        { id: 'tab-1', title: 'Query 1', text: 'kept' },
      ]);
    }
  });

  it('does not accept two tabs with one id', () => {
    const twice = JSON.stringify({
      tabs: [
        { id: 'a', title: 'A', text: '' },
        { id: 'a', title: 'B', text: '' },
      ],
      activeId: 'a',
      next: 3,
    });
    expect(restoreTabs(twice, 'kept').tabs).toHaveLength(1);
  });

  it('repairs an active id that is not among the tabs and a counter that is too low', () => {
    const odd = JSON.stringify({
      tabs: [
        { id: 'tab-5', title: 'A', text: '' },
        { id: 'tab-9', title: 'B', text: '' },
      ],
      activeId: 'gone',
      next: 1,
    });
    const saved = restoreTabs(odd, '');
    expect(saved.activeId).toBe('tab-5');
    expect(saved.next).toBe(3);
  });
});

describe('addTab', () => {
  it('opens at the end, in front, with a new id', () => {
    const { state, id } = addTab(start(), 'SELECT 1;');
    expect(state.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2']);
    expect(id).toBe('tab-2');
    expect(state.activeId).toBe('tab-2');
    expect(state.tabs[1]?.title).toBe('SELECT 1');
  });

  it('never reuses an id after a tab is closed', () => {
    let state = addTab(start()).state;
    state = closeTab(state, 'tab-2');
    expect(addTab(state).id).toBe('tab-3');
  });
});

describe('closeTab', () => {
  const three = () => addTab(addTab(start()).state).state;

  it('brings the neighbour to the front when the front tab closes', () => {
    let state = activateTab(three(), 'tab-2');
    state = closeTab(state, 'tab-2');
    expect(state.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-3']);
    expect(state.activeId).toBe('tab-3');
    // Closing the last one in the row falls back to the one before it.
    state = closeTab(state, 'tab-3');
    expect(state.activeId).toBe('tab-1');
  });

  it('leaves the front tab alone when another closes', () => {
    const state = closeTab(three(), 'tab-1');
    expect(state.activeId).toBe('tab-3');
  });

  it('replaces the last tab with an empty one', () => {
    const state = closeTab(start(), 'tab-1');
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.id).toBe('tab-2');
    expect(state.activeId).toBe('tab-2');
  });

  it('ignores an id it does not have', () => {
    const state = three();
    expect(closeTab(state, 'nope')).toBe(state);
    expect(activateTab(state, 'nope')).toBe(state);
  });
});
