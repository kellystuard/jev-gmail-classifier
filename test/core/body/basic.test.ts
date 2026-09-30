import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { NAMED_ENTITIES, basicConverter, basicHtmlToText } from '../../../src/core/body/basic.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'gmail');

/** The decoded text of one part of a Gmail fixture (`<name>.expected.json`). */
function fixturePart(name: string, partId: string): string {
  const parsed = z
    .record(z.string(), z.string())
    .parse(JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8')));
  const text = parsed[partId];
  if (text === undefined) {
    throw new Error(`${name} has no part ${partId}`);
  }
  return text;
}

type Row = readonly [description: string, html: string, text: string];

function table(rows: readonly Row[]): void {
  it.each(rows)('%s', (_description, html, text) => {
    expect(basicHtmlToText(html)).toBe(text);
  });
}

describe('basicHtmlToText: dropped content', () => {
  table([
    ['a comment', 'a<!-- hidden -->b', 'ab'],
    ['a comment with markup inside', 'a<!-- <p>hidden</p> -->b', 'ab'],
    ['an Outlook conditional comment', 'a<!--[if mso]><p>hidden</p><![endif]-->b', 'ab'],
    [
      'a downlevel-revealed comment keeps its content',
      '<!--[if !mso]><!-->shown<!--<![endif]-->',
      'shown',
    ],
    ['an empty comment `<!-->`', 'a<!-->b', 'ab'],
    ['`<!--->`', 'a<!--->b', 'ab'],
    ['an unclosed comment drops the rest', 'a<!-- hidden <p>more', 'a'],
    ['a doctype', '<!DOCTYPE html>text', 'text'],
    ['a CDATA section', 'a<![CDATA[ hidden > still ]]>b', 'ab'],
    ['a processing instruction', '<?xml version="1.0"?>text', 'text'],
    [
      'head',
      '<html><head><title>Title</title><meta charset="utf-8"></head><body>text</body></html>',
      'text',
    ],
    [
      'head without </head> ends at <body',
      '<head><title>Title</title><BODY class="x">text',
      'text',
    ],
    ['head without </head> or <body drops the rest', '<head><title>Title</title>text', ''],
    ['style', 'a<style>p { color: red; }</style>b', 'ab'],
    ['style in upper case', 'a<STYLE type="text/css">p{}</Style >b', 'ab'],
    ['script', 'a<script>if (a < b) { x = "</p>"; }</script>b', 'ab'],
    ['noscript', 'a<noscript>hidden</noscript>b', 'ab'],
    ['template', 'a<template><p>hidden</p></template>b', 'ab'],
    ['an unclosed style drops the rest', 'a<style>p {}', 'a'],
    ['a closing tag that only starts like the name', 'a<style>x</styles>y</style>b', 'ab'],
  ]);
});

describe('basicHtmlToText: tags', () => {
  table([
    ['uppercase tags', '<P>one</P><P>two<BR/>three</P>', 'one\n\ntwo\nthree'],
    ['a > inside a double-quoted attribute', '<a title="x > y">text</a>', 'text'],
    ['a > inside a single-quoted attribute', "<span data-x='a>b'>text</span>", 'text'],
    ['a quote with space around =', '<a title = "x > y">text</a>', 'text'],
    ['an unquoted attribute', '<font color=red>text</font>', 'text'],
    ['an unclosed quote drops the rest', '<a title="x>text', ''],
    ['a literal < before a space', 'a < b', 'a < b'],
    ['a literal < before a digit', '1<2 and 3>2', '1<2 and 3>2'],
    ['a lone <', '<', '<'],
    ['a tag with no > drops the rest', 'text <b', 'text'],
    ['a closing tag with no > drops the rest', 'text </b', 'text'],
    ['a bogus closing tag', 'a</ x>b', 'ab'],
    ['`</>`', 'a</>b', 'ab'],
    ['an unknown tag keeps its text', '<o:p>text</o:p><custom-tag>more</custom-tag>', 'textmore'],
    [
      'inline tags keep their text',
      'a <b>bold</b> and <i>italic</i> <span>span</span>',
      'a bold and italic span',
    ],
    [
      'a link keeps only its text',
      'see <a href="https://example.com/x">the page</a>.',
      'see the page.',
    ],
    ['an image and its alt are dropped', 'a<img src="x.png" alt="Logo">b', 'ab'],
    ['a self-closing image', 'a <img src="x.png" alt="Logo"/> b', 'a b'],
  ]);
});

describe('basicHtmlToText: line breaks', () => {
  table([
    ['<br> gives a line break', 'a<br>b', 'a\nb'],
    ['<br/> and <br />', 'a<br/>b<br />c', 'a\nb\nc'],
    ['</br> is a <br>', 'a</br>b', 'a\nb'],
    ['<br><br> gives a blank line', 'a<br><br>b', 'a\n\nb'],
    ['more <br>s still give one blank line', 'a<br><br><br><br>b', 'a\n\nb'],
    [
      'nested divs give no empty lines',
      '<div><div><div>a</div></div></div><div><div>b</div></div>',
      'a\nb',
    ],
    ['a div ends the line', 'a<div>b</div>c', 'a\nb\nc'],
    ['p gives one blank line', '<p>a</p><p>b</p>', 'a\n\nb'],
    ['text around a p', 'a<p>b</p>c', 'a\n\nb\n\nc'],
    ['headings', '<h1>Title</h1><h6>Small</h6>text', 'Title\n\nSmall\n\ntext'],
    ['blockquote', 'a<blockquote>quoted</blockquote>b', 'a\n\nquoted\n\nb'],
    ['hr', 'a<hr>b', 'a\n\nb'],
    ['pre collapses its whitespace in v1', '<pre>a   b\n  c</pre>', 'a b c'],
    [
      'section, article, header, footer',
      '<header>h</header><section>s</section><article>a</article><footer>f</footer>',
      'h\ns\na\nf',
    ],
    [
      'center, address, main, nav, aside',
      '<center>c</center><address>a</address><main>m</main><nav>n</nav><aside>s</aside>',
      'c\na\nm\nn\ns',
    ],
    [
      'form, fieldset, details, summary',
      '<form><fieldset>f</fieldset></form><details><summary>s</summary>d</details>',
      'f\ns\nd',
    ],
    ['figure and figcaption', '<figure>f<figcaption>c</figcaption></figure>', 'f\nc'],
    ['dl, dt, dd', 'a<dl><dt>term</dt><dd>definition</dd></dl>b', 'a\n\nterm\ndefinition\n\nb'],
    ['a leading and trailing blank line are trimmed', '<p>a</p>', 'a'],
    ['a leading <br> is trimmed', '<br>a<br>', 'a'],
  ]);
});

describe('basicHtmlToText: lists and tables', () => {
  table([
    ['list items start with "- "', '<ul><li>one</li><li>two</li></ul>', '- one\n- two'],
    ['an ordered list', 'intro<ol><li>one<li>two</ol>after', 'intro\n\n- one\n- two\n\nafter'],
    ['an empty item leaves nothing', '<ul><li></li><li>two</li></ul>', '- two'],
    ['an item whose text is in a p', '<ul><li><p>one</p></li></ul>', '- one'],
    ['a <br> inside an item', '<li>a<br>b</li>', '- a\nb'],
    ['a two-cell row', '<table><tr><td>a</td><td>b</td></tr></table>', 'a b'],
    [
      'two rows',
      '<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><th>d</th></tr></table>',
      'a b\nc d',
    ],
    ['cells without closing tags', '<table><tr><td>a<td>b<tr><td>c</table>', 'a b\nc'],
    [
      'tbody, thead, tfoot, caption',
      '<table><caption>cap</caption><thead><tr><th>h</th></tr></thead><tbody><tr><td>b</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
      'cap\nh\nb\nf',
    ],
    [
      'a table leaves a blank line around it',
      'a<table><tr><td>x</td></tr></table>b',
      'a\n\nx\n\nb',
    ],
  ]);
});

describe('basicHtmlToText: numeric references', () => {
  table([
    ['decimal', '&#65;&#233;&#128578;', 'Aé🙂'],
    ['hex, lower-case x', '&#x41;&#xe9;&#x1F642;', 'Aé🙂'],
    ['hex, upper-case X and digits', '&#X41;&#XE9;&#x1f642;', 'Aé🙂'],
    ['leading zeros', '&#0065;&#x0041;', 'AA'],
    [
      '128 to 159 are windows-1252',
      '&#128;&#130;&#133;&#145;&#146;&#147;&#148;&#149;&#150;&#151;&#153;',
      '€‚…‘’“”•–—™',
    ],
    ['hex 0x80 to 0x9F too', '&#x80;&#x9f;', '€Ÿ'],
    [
      'windows-1252 holes stay as the C1 control',
      '&#129;&#141;&#143;&#144;&#157;',
      '\u0081\u008D\u008F\u0090\u009D',
    ],
    ['0 becomes U+FFFD', 'a&#0;b', 'a�b'],
    ['above U+10FFFF becomes U+FFFD', 'a&#x110000;b&#99999999999999999999;c', 'a�b�c'],
    ['a surrogate becomes U+FFFD', 'a&#xD800;b&#57343;c', 'a�b�c'],
    ['U+10FFFF is kept', '&#x10FFFF;', '\u{10FFFF}'],
    ['no ; stays as it is', 'a&#65 b&#x41', 'a&#65 b&#x41'],
    ['no digits stays as it is', '&#; &#x; &#xG;', '&#; &#x; &#xG;'],
    ['a decoded newline is whitespace', 'a&#10;b', 'a b'],
  ]);
});

describe('basicHtmlToText: named references', () => {
  table([
    ['markup characters', '&lt;b&gt; &amp; &quot;q&quot; &apos;a&apos;', '<b> & "q" \'a\''],
    ['a decoded tag is text, never a tag', '&lt;p&gt;hidden?&lt;/p&gt;', '<p>hidden?</p>'],
    ['decoded once: &amp;lt; is &lt;', '&amp;lt; &amp;amp;', '&lt; &amp;'],
    ['case-sensitive', '&Eacute;&eacute;&AMP;', 'Éé&AMP;'],
    ['an unknown name stays', '&foo; &bogus;', '&foo; &bogus;'],
    ['no ; stays', 'AT&T &amp &copy 2026', 'AT&T &amp &copy 2026'],
    [
      'a prototype name stays',
      '&constructor; &toString; &__proto__; &hasOwnProperty;',
      '&constructor; &toString; &__proto__; &hasOwnProperty;',
    ],
    ['a lone &', 'a & b &', 'a & b &'],
    ['an entity in an attribute is never decoded into text', '<a title="&lt;x&gt;">t</a>', 't'],
  ]);

  // Every name the table must hold, with an independently written code point.
  const latin1 = [
    'nbsp',
    'iexcl',
    'cent',
    'pound',
    'curren',
    'yen',
    'brvbar',
    'sect',
    'uml',
    'copy',
    'ordf',
    'laquo',
    'not',
    'shy',
    'reg',
    'macr',
    'deg',
    'plusmn',
    'sup2',
    'sup3',
    'acute',
    'micro',
    'para',
    'middot',
    'cedil',
    'sup1',
    'ordm',
    'raquo',
    'frac14',
    'frac12',
    'frac34',
    'iquest',
    'Agrave',
    'Aacute',
    'Acirc',
    'Atilde',
    'Auml',
    'Aring',
    'AElig',
    'Ccedil',
    'Egrave',
    'Eacute',
    'Ecirc',
    'Euml',
    'Igrave',
    'Iacute',
    'Icirc',
    'Iuml',
    'ETH',
    'Ntilde',
    'Ograve',
    'Oacute',
    'Ocirc',
    'Otilde',
    'Ouml',
    'times',
    'Oslash',
    'Ugrave',
    'Uacute',
    'Ucirc',
    'Uuml',
    'Yacute',
    'THORN',
    'szlig',
    'agrave',
    'aacute',
    'acirc',
    'atilde',
    'auml',
    'aring',
    'aelig',
    'ccedil',
    'egrave',
    'eacute',
    'ecirc',
    'euml',
    'igrave',
    'iacute',
    'icirc',
    'iuml',
    'eth',
    'ntilde',
    'ograve',
    'oacute',
    'ocirc',
    'otilde',
    'ouml',
    'divide',
    'oslash',
    'ugrave',
    'uacute',
    'ucirc',
    'uuml',
    'yacute',
    'thorn',
    'yuml',
  ];
  const others: Record<string, number> = {
    amp: 0x26,
    lt: 0x3c,
    gt: 0x3e,
    quot: 0x22,
    apos: 0x27,
    trade: 0x2122,
    hellip: 0x2026,
    mdash: 0x2014,
    ndash: 0x2013,
    lsquo: 0x2018,
    rsquo: 0x2019,
    sbquo: 0x201a,
    ldquo: 0x201c,
    rdquo: 0x201d,
    bdquo: 0x201e,
    lsaquo: 0x2039,
    rsaquo: 0x203a,
    bull: 0x2022,
    euro: 0x20ac,
    dagger: 0x2020,
    Dagger: 0x2021,
    permil: 0x2030,
    prime: 0x2032,
    Prime: 0x2033,
    ensp: 0x2002,
    emsp: 0x2003,
    thinsp: 0x2009,
    zwnj: 0x200c,
    zwj: 0x200d,
    lrm: 0x200e,
    rlm: 0x200f,
    larr: 0x2190,
    rarr: 0x2192,
    uarr: 0x2191,
    darr: 0x2193,
    fnof: 0x192,
    circ: 0x2c6,
    tilde: 0x2dc,
    OElig: 0x152,
    oelig: 0x153,
    Scaron: 0x160,
    scaron: 0x161,
    Yuml: 0x178,
  };
  const expected: [string, number][] = [
    ...latin1.map((name, index): [string, number] => [name, 0xa0 + index]),
    ...Object.entries(others),
  ];

  it('holds exactly the settled list', () => {
    expect(latin1).toHaveLength(96);
    expect(Object.keys(NAMED_ENTITIES).sort()).toEqual(expected.map(([name]) => name).sort());
  });

  /** What `x<char>y` becomes after the invisible-character and nbsp rules. */
  function between(codePoint: number): string {
    if ([0xad, 0x200c, 0x200d].includes(codePoint)) {
      return 'xy';
    }
    return codePoint === 0xa0 ? 'x y' : `x${String.fromCodePoint(codePoint)}y`;
  }

  it.each(expected)('decodes &%s;', (name, codePoint) => {
    expect(NAMED_ENTITIES[name]).toBe(String.fromCodePoint(codePoint));
    expect(basicHtmlToText(`x&${name};y`)).toBe(between(codePoint));
  });
});

describe('basicHtmlToText: invisible characters and spaces', () => {
  table([
    [
      'preheader padding as entities',
      'Sale&zwnj;&nbsp;&zwnj;&nbsp;&#847;&#8203;&shy;ends',
      'Sale ends',
    ],
    [
      'each invisible character, literal',
      'a\u00AD\u034F\u180E\u200B\u200C\u200D\u2060\u2061\u2062\u2063\u2064\uFEFFb',
      'ab',
    ],
    [
      'each invisible character, as a numeric reference',
      'a&#173;&#847;&#6158;&#8203;&#8204;&#8205;&#8288;&#8292;&#65279;b',
      'ab',
    ],
    ['non-breaking spaces become spaces', 'a\u00A0b\u202Fc\u2007d', 'a b c d'],
    ['a run of &nbsp; collapses', 'a&nbsp;&nbsp;&nbsp;b', 'a b'],
    ['a line of only padding is empty', '<div>&zwnj;&nbsp;&#847;</div><div>text</div>', 'text'],
    ['other spaces are kept', 'a&ensp;b&emsp;c', 'a\u2002b\u2003c'],
    ['lrm and rlm are kept', 'a&lrm;b&rlm;c', 'a\u200Eb\u200Fc'],
  ]);
});

describe('basicHtmlToText: whitespace', () => {
  table([
    ['empty input', '', ''],
    ['only whitespace', ' \n\t ', ''],
    ['text with no tags', 'Just text.', 'Just text.'],
    ['a run of whitespace becomes one space', 'a  \t b\n\nc\r\nd\fe', 'a b c d e'],
    ['source newlines are not line breaks', 'one\ntwo', 'one two'],
    ['whitespace across tags collapses', 'a <b> b </b> c', 'a b c'],
    ['each line is trimmed', '<div>  a  </div><div>\n b \n</div>', 'a\nb'],
    ['no \\r in the output', 'a\r\nb<br>\r\nc', 'a b\nc'],
  ]);
});

describe('basicHtmlToText: fixtures', () => {
  it('converts 02 (HTML only, with a <style> in <head>)', () => {
    expect(basicHtmlToText(fixturePart('02-html-utf8-qp', ''))).toBe(
      'Scenario 2: HTML only, UTF-8, quoted-printable. Café, naïve, “quotes”, an equals sign a=b.\n' +
        '\n' +
        'This paragraph is deliberately longer than seventy-six characters so that quoted-printable needs a soft line break.',
    );
  });

  it('converts 06 (windows-1252 punctuation)', () => {
    expect(basicHtmlToText(fixturePart('06-html-windows-1252-qp', ''))).toBe(
      'Scenario 6: windows-1252 “curly quotes”, ‘single’, € 5, em dash — en dash –, ellipsis …, trademark ™, bullet •.',
    );
  });

  it('converts 12 (composed in Gmail)', () => {
    expect(basicHtmlToText(fixturePart('12-gmail-composed-html', '1'))).toBe(
      'Synthetic s29-12 body: bold words and a link. Größe café 日本.',
    );
  });

  it('converts 03 (the HTML alternative)', () => {
    expect(basicHtmlToText(fixturePart('03-alternative-utf8-base64', '1'))).toBe(
      'Scenario 3: multipart/alternative, UTF-8, base64.\n\nGrüße, 日本語, emoji 🙂.',
    );
  });
});

describe('basicHtmlToText: a marketing email', () => {
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <title>Autumn Sale</title>
  <style type="text/css">
    body { margin: 0; } .hidden { display: none; }
    @media only screen and (max-width: 600px) { .col > td { display: block; } }
  </style>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0">
  <div class="hidden" style="display:none;max-height:0;overflow:hidden">Up to 40% off this weekend only&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&#847; &#847; &#847; &zwnj;&nbsp;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center">
        <a href="https://shop.example.com/?utm_source=email"><img src="https://shop.example.com/logo.png" alt="Example Shop logo" width="120"></a>
      </td>
    </tr>
    <tr>
      <td>
        <h1 style="font-size:24px">The Autumn Sale is here</h1>
        <p>Hi there,<br>everything in store is up to 40&#37; off until Sunday.</p>
        <!--[if mso]><table><tr><td>Outlook-only spacer text</td></tr></table><![endif]-->
        <table class="col"><tr><td>Boots &mdash; &euro;59</td><td>Scarves &mdash; &euro;19</td></tr></table>
        <p><a href="https://shop.example.com/sale" style="background:#000;color:#fff">Shop the sale&nbsp;&rarr;</a></p>
      </td>
    </tr>
    <tr>
      <td style="font-size:11px;color:#999">
        <p>You received this because you signed up at Example Shop.<br>
        <a href="https://shop.example.com/unsubscribe?u=123">Unsubscribe</a> | <a href="https://shop.example.com/prefs">Preferences</a></p>
        <p>&copy; 2026 Example Shop, 1 Example Street</p>
      </td>
    </tr>
  </table>
  <img src="https://shop.example.com/open.gif" width="1" height="1" alt="">
</body>
</html>`;

  it('reads in order, with none of the hidden content', () => {
    expect(basicHtmlToText(html)).toBe(
      [
        'Up to 40% off this weekend only',
        '',
        'The Autumn Sale is here',
        '',
        'Hi there,',
        'everything in store is up to 40% off until Sunday.',
        '',
        'Boots — €59 Scarves — €19',
        '',
        'Shop the sale →',
        '',
        'You received this because you signed up at Example Shop.',
        'Unsubscribe | Preferences',
        '',
        '© 2026 Example Shop, 1 Example Street',
      ].join('\n'),
    );
  });

  it('leaves out the head, style, comments, images and links', () => {
    const text = basicHtmlToText(html);
    for (const hidden of [
      'Autumn Sale</',
      'display',
      'PixelsPerInch',
      'Outlook-only',
      'logo',
      'https://',
      '&',
      '<',
      '\u200C',
      '\u034F',
    ]) {
      expect(text).not.toContain(hidden);
    }
  });
});

describe('basicHtmlToText: linear time', () => {
  const MB = 1_000_000;
  const inputs: readonly (readonly [string, string])[] = [
    [
      'ordinary markup repeated',
      '<div class="row"><p>Hello <b>world</b> &amp; <a href="https://example.com/?a=1&amp;b=2">friends</a>&nbsp;&#8203;</p><br></div>'.repeat(
        MB / 100,
      ),
    ],
    ['1 MB of < with no >', '<'.repeat(MB)],
    ['<a followed by 1 MB of attribute text', `<a ${'x'.repeat(MB)}`],
    ['<a followed by 1 MB of = and quotes', `<a ${'="x" '.repeat(MB / 5)}`],
    ['1 MB of &', '&'.repeat(MB)],
    ['1 MB of &#', '&#'.repeat(MB / 2)],
    ['&# followed by 1 MB of digits', `&#${'9'.repeat(MB)}`],
    ['1 MB of named-looking references without ;', '&amp'.repeat(MB / 4)],
    ['an unclosed <!--', `<!--${'a'.repeat(MB)}`],
    ['1 MB of <!--', '<!--'.repeat(MB / 4)],
    ['an unclosed <style> full of near-closing tags', `<style>${'</styl'.repeat(MB / 6)}`],
    ['<head> full of near-<body tags', `<head>${'<bod'.repeat(MB / 4)}`],
    ['deeply nested divs', `${'<div>'.repeat(MB / 11)}x${'</div>'.repeat(MB / 11)}`],
    ['1 MB of </', '</'.repeat(MB / 2)],
    ['1 MB of whitespace', ' \n'.repeat(MB / 2)],
  ];

  it.each(inputs)(
    'converts %s in well under a second',
    (_description, html) => {
      const start = performance.now();
      basicHtmlToText(html);
      expect(performance.now() - start).toBeLessThan(1000);
    },
    5000,
  );
});

describe('basicConverter', () => {
  it('is the basic method', () => {
    expect(basicConverter.method).toBe('basic');
    expect(basicConverter.htmlToText('<p>a</p><p>b</p>')).toBe('a\n\nb');
  });
});
