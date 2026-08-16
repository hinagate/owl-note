import { describe, it, expect } from 'vitest';
import { renumberOrderedList } from '../src/lib/format.js';

// Apply the edit the way the editor does, and report the resulting text + caret.
const apply = (body, caret) => {
  const edit = renumberOrderedList(body, caret);
  if (!edit) return null;
  return {
    text: body.slice(0, edit.replaceStart) + edit.insert + body.slice(edit.replaceEnd),
    caret: edit.selStart,
  };
};
const caretAfter = (body, needle) => body.indexOf(needle) + needle.length;
const NL = String.fromCharCode(10); // avoids escaping newlines inside these fixtures

describe('renumberOrderedList', () => {
  it('closes the gap left by a deleted item', () => {
    const body = '1. alpha\n3. gamma\n4. delta';
    expect(apply(body, caretAfter(body, '3. gam')).text)
      .toBe('1. alpha\n2. gamma\n3. delta');
  });

  it('renumbers after an item is inserted in the middle', () => {
    const body = '1. alpha\n2. inserted\n2. beta\n3. gamma';
    expect(apply(body, caretAfter(body, '2. inser')).text)
      .toBe('1. alpha\n2. inserted\n3. beta\n4. gamma');
  });

  it('keeps counting from the first item, so a list starting at 5 still does', () => {
    const body = '5. five\n9. six\n9. seven';
    expect(apply(body, caretAfter(body, '9. six')).text)
      .toBe('5. five\n6. six\n7. seven');
  });

  it('does nothing when the numbering is already correct', () => {
    const body = '1. a\n2. b\n3. c';
    expect(renumberOrderedList(body, caretAfter(body, '2. b'))).toBeNull();
  });

  it('does nothing when the caret is not in an ordered list', () => {
    expect(renumberOrderedList('- a\n- b', 3)).toBeNull();
    expect(renumberOrderedList('plain text', 4)).toBeNull();
    expect(renumberOrderedList('', 0)).toBeNull();
  });

  it('leaves a lone item alone', () => {
    expect(renumberOrderedList('7. only one', 5)).toBeNull();
  });

  // A nested list is its own sequence; folding it into the parent would be wrong.
  it('renumbers only the caret\'s own indent level', () => {
    const body = '1. one\n2. two\n   1. sub a\n   5. sub b\n3. three';
    expect(apply(body, caretAfter(body, '   5. sub')).text)
      .toBe('1. one\n2. two\n   1. sub a\n   2. sub b\n3. three');
  });

  it('does not let a nested list break the parent run', () => {
    const body = '1. one\n   1. sub\n5. two\n6. three';
    expect(apply(body, caretAfter(body, '5. two')).text)
      .toBe('1. one\n   1. sub\n2. two\n3. three');
  });

  it('treats a quoted list as its own sequence', () => {
    const body = '> 1. a\n> 4. b\n> 5. c';
    expect(apply(body, caretAfter(body, '> 4. b')).text)
      .toBe('> 1. a\n> 2. b\n> 3. c');
  });

  it('keeps a loose list (blank lines between items) as one list', () => {
    const body = '1. a\n\n4. b\n\n7. c';
    expect(apply(body, caretAfter(body, '4. b')).text)
      .toBe('1. a\n\n2. b\n\n3. c');
  });

  it('stops at a paragraph that ends the list', () => {
    const body = '1. a\n3. b\n\nSome paragraph.\n\n9. later list\n9. more';
    expect(apply(body, caretAfter(body, '3. b')).text)
      .toBe('1. a\n2. b\n\nSome paragraph.\n\n9. later list\n9. more');
  });

  // Renumbering a code sample would corrupt the thing being demonstrated.
  it('never touches a list inside a fenced code block', () => {
    const body = '```\n1. a\n5. b\n```';
    expect(renumberOrderedList(body, caretAfter(body, '5. b'))).toBeNull();
  });

  it('still renumbers a real list that follows a code fence', () => {
    const body = '```\ncode\n```\n\n1. a\n6. b';
    expect(apply(body, caretAfter(body, '6. b')).text)
      .toBe('```\ncode\n```\n\n1. a\n2. b');
  });

  describe('caret handling', () => {
    it('keeps the caret on the same character when widths do not change', () => {
      const body = '1. alpha\n3. gamma';
      const out = apply(body, caretAfter(body, '3. gam'));
      expect(out.text.slice(0, out.caret)).toBe('1. alpha\n2. gam');
    });

    // 9 -> 10 grows the line, and every earlier line can grow too.
    it('follows the text when a number gets wider', () => {
      const body = ['9. i', '9. j', '9. k'].join('\n');
      const out = apply(body, caretAfter(body, '9. j'));
      expect(out.text).toBe('9. i\n10. j\n11. k');
      expect(out.text.slice(0, out.caret)).toBe('9. i\n10. j');
    });

    it('follows the text when a number gets narrower', () => {
      const body = ['1. i', '10. j', '11. k'].join('\n');
      const out = apply(body, caretAfter(body, '10. j'));
      expect(out.text).toBe('1. i\n2. j\n3. k');
      expect(out.text.slice(0, out.caret)).toBe('1. i\n2. j');
    });

    it('never places the caret outside the rewritten block', () => {
      const body = '1. a\n5. b\n9. c';
      for (let caret = 0; caret <= body.length; caret += 1) {
        const edit = renumberOrderedList(body, caret);
        if (!edit) continue;
        expect(edit.selStart).toBeGreaterThanOrEqual(edit.replaceStart);
        expect(edit.selStart).toBeLessThanOrEqual(edit.replaceStart + edit.insert.length);
      }
    });
  });

  it('is idempotent — running it on its own output changes nothing', () => {
    const body = '1. a\n7. b\n7. c';
    const once = apply(body, caretAfter(body, '7. b'));
    expect(renumberOrderedList(once.text, once.caret)).toBeNull();
  });

  // Reported: a list whose items carry explanation lines beneath them only
  // renumbered up to the first explanation, because an unindented continuation
  // line looked like the end of the list.
  describe('items with continuation lines under them', () => {
    const note = [
      '1. a to b linking',
      'look around',
      '2. b to c gliding',
      'see it',
      '4. go back, see me',
      '5. stops and assimilation',
      '6. went looking',
    ].join(NL);

    it('renumbers past the continuation lines', () => {
      const out = apply(note, caretAfter(note, '4. go back'));
      expect(out.text).toBe([
        '1. a to b linking',
        'look around',
        '2. b to c gliding',
        'see it',
        '3. go back, see me',
        '4. stops and assimilation',
        '5. went looking',
      ].join(NL));
    });

    it('leaves the continuation lines untouched', () => {
      const out = apply(note, caretAfter(note, '4. go back'));
      expect(out.text).toContain('look around');
      expect(out.text).toContain('see it');
    });


    // Deleting an item leaves the caret on the FOLLOWING line, which is usually
    // that item's explanation, not a numbered one. Bailing there meant the edit
    // that creates the gap was exactly the edit that never closed it.
    it('renumbers when the caret is left on a continuation line', () => {
      const afterDelete = [
        '1. a to b linking',
        'look around',
        '2. b to c gliding',
        'see it',
        'the explanation of the deleted item',
        '4. go back, see me',
        '5. stops',
      ].join(NL);
      const caret = afterDelete.indexOf('the explanation');
      const out = apply(afterDelete, caret);
      expect(out.text.split(NL).filter((l) => /^\d+\. /.test(l)))
        .toEqual(['1. a to b linking', '2. b to c gliding', '3. go back, see me', '4. stops']);
    });

    it('does not reach into a list from a paragraph separated by a blank line', () => {
      const body = ['1. a', '3. b', '', 'A separate paragraph.'].join(NL);
      expect(renumberOrderedList(body, body.indexOf('A separate'))).toBeNull();
    });

    it('still stops at a paragraph that follows a blank line', () => {
      const body = [
        '1. a',
        'continuation of a',
        '3. b',
        '',
        'A separate paragraph.',
        '',
        '9. a different list',
        '9. more',
      ].join(NL);
      const out = apply(body, caretAfter(body, '3. b'));
      expect(out.text).toContain('9. a different list');
      expect(out.text).toContain(['1. a', 'continuation of a', '2. b'].join(NL));
    });
  });
});
