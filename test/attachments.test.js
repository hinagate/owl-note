import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { classifyUrl, parseAttachmentInput, canOpenFileUrls } from '../src/lib/attachments.js';

beforeEach(() => installFakeChrome());

describe('attachments', () => {
  it('classifies urls', () => {
    expect(classifyUrl('https://x.com')).toBe('web');
    expect(classifyUrl('file:///C:/a.pdf')).toBe('file');
    expect(classifyUrl('ftp://x')).toBe('other');
  });

  it('parses label | url form', () => {
    expect(parseAttachmentInput('Spec | https://x.com')).toEqual({ kind: 'web', href: 'https://x.com', label: 'Spec' });
    expect(parseAttachmentInput('file:///C:/a.pdf')).toEqual({ kind: 'file', href: 'file:///C:/a.pdf', label: 'file:///C:/a.pdf' });
  });

  it('reads the file-scheme access toggle (false in fake chrome)', async () => {
    expect(await canOpenFileUrls()).toBe(false);
  });
});
