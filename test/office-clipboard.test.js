import { describe, it, expect } from 'vitest';
import { officeClipboardMarkdown, isOfficeClipboardHtml } from '../src/lib/office-clipboard.js';

// Trimmed but structurally faithful copies of what Chrome hands back from
// getData('text/html') after a copy in Excel / Word on Windows.
const EXCEL_RANGE = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=ProgId content=Excel.Sheet>
<meta name=Generator content="Microsoft Excel 15">
<style><!--table {mso-displayed-decimal-separator:"\.";} .xl65 {font-weight:700;}--></style>
</head>
<body link="#0563C1" vlink="#954F72">
<table border=0 cellpadding=0 cellspacing=0 width=192 style='border-collapse:collapse;width:144pt'>
<!--StartFragment-->
 <col width=64 span=3 style='width:48pt'>
 <tr height=20 style='height:15.0pt'>
  <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>Region</td>
  <td class=xl65 width=64 style='width:48pt'>Q1</td>
  <td class=xl65 width=64 style='width:48pt'>Q2</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td height=20 style='height:15.0pt'>North</td>
  <td align=right>120</td>
  <td align=right>145</td>
 </tr>
<!--EndFragment-->
</table>
</body>
</html>`;

const WORD_TEXT = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta name=ProgId content=Word.Document>
<meta name=Generator content="Microsoft Word 15">
<link rel=File-List href="file:///C:/Users/a/AppData/Local/Temp/msohtmlclip1/01/clip_filelist.xml">
<style><!-- p.MsoNormal {mso-style-parent:"";font-size:11.0pt;} --></style>
</head>
<body lang=EN-US>
<!--StartFragment-->
<h1>Quarterly Report</h1>
<p class=MsoNormal>Revenue was <b>up</b> this quarter.<o:p></o:p></p>
<ul><li class=MsoNormal>North grew</li><li class=MsoNormal>South held</li></ul>
<!--EndFragment-->
</body>
</html>`;

const WORD_PICTURE = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>
<!--StartFragment--><p class=MsoNormal><img width=400 height=300
src="file:///C:/Users/a/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png"><o:p></o:p></p>
<!--EndFragment--></body></html>`;

describe('isOfficeClipboardHtml', () => {
  it('recognises Word and Excel clipboard HTML', () => {
    expect(isOfficeClipboardHtml(EXCEL_RANGE)).toBe(true);
    expect(isOfficeClipboardHtml(WORD_TEXT)).toBe(true);
  });

  it('leaves every other source alone', () => {
    expect(isOfficeClipboardHtml('<p>hello <b>world</b></p>')).toBe(false);
    expect(isOfficeClipboardHtml('<div class="prose"><h1>A blog post</h1></div>')).toBe(false);
    expect(isOfficeClipboardHtml('')).toBe(false);
  });
});

describe('officeClipboardMarkdown', () => {
  it('turns a copied Excel range into an editable GFM table', () => {
    const md = officeClipboardMarkdown(EXCEL_RANGE);
    expect(md).toMatch(/\|\s*Region\s*\|\s*Q1\s*\|\s*Q2\s*\|/);
    expect(md).toMatch(/\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|/); // header separator: a real table
    expect(md).toMatch(/\|\s*North\s*\|\s*120\s*\|\s*145\s*\|/);
    expect(md).not.toContain('<table');
  });

  it('drops the inline stylesheet and the column widths Excel ships with it', () => {
    const md = officeClipboardMarkdown(EXCEL_RANGE);
    expect(md).not.toContain('mso-displayed-decimal-separator');
    expect(md).not.toContain('48pt');
    expect(md).not.toContain('xl65');
  });

  it('keeps Word headings, emphasis and lists', () => {
    const md = officeClipboardMarkdown(WORD_TEXT);
    expect(md).toContain('# Quarterly Report');
    expect(md).toContain('**up**');
    // turndown pads its bullets ('-   item'), same as the .docx importer already does.
    expect(md).toMatch(/^-\s+North grew$/m);
    expect(md).toMatch(/^-\s+South held$/m);
  });

  it('returns nothing for a copied picture, so the caller keeps the bitmap', () => {
    // Word's only HTML for a picture is an <img> pointing at a temp file no extension
    // can read, so there is nothing to convert and the clipboard bitmap is the real data.
    expect(officeClipboardMarkdown(WORD_PICTURE)).toBe('');
    expect(officeClipboardMarkdown(WORD_PICTURE)).not.toContain('clip_image001');
  });

  it('ignores HTML that did not come from Office', () => {
    expect(officeClipboardMarkdown('<h1>A blog post</h1><p>text</p>')).toBe('');
    expect(officeClipboardMarkdown('')).toBe('');
  });

  it('normalises the non-breaking spaces Office pads cells with', () => {
    const md = officeClipboardMarkdown(
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><table>'
      + '<tr><td>A&nbsp;B</td><td>C</td></tr><tr><td>1</td><td>2</td></tr>'
      + '</table></body></html>',
    );
    expect(md).toContain('A B');
    expect(md).not.toContain('\u00a0');
  });
});
