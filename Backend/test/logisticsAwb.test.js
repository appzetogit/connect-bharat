import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AWB_LENGTH,
  buildAwb,
  buildQrPayload,
  computeAwbCheckDigit,
  computeLuhnDigit,
  extractAwbFromScan,
  formatAwbDate,
  isValidAwb,
  normalizeCityCode,
} from '../src/modules/taxi/logistics/services/awb.js';

describe('AWB check digit', () => {
  it('matches the textbook Luhn examples', () => {
    // 7992739871 → check digit 3 (the standard Luhn worked example).
    assert.equal(computeLuhnDigit('7992739871'), '3');
    assert.equal(computeLuhnDigit('0'), '0');
  });

  it('detects every single-character substitution', () => {
    const awb = buildAwb({ cityCode: 'BLR', date: new Date('2026-10-03T06:00:00Z'), sequence: 427 });
    assert.ok(isValidAwb(awb));
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    // Only the digit positions can be mistyped and still look like an AWB.
    for (let index = 5; index < awb.length - 1; index += 1) {
      for (const char of '0123456789') {
        if (char === awb[index]) continue;
        const typo = awb.slice(0, index) + char + awb.slice(index + 1);
        assert.equal(isValidAwb(typo), false, `undetected typo at ${index}: ${typo}`);
      }
    }
    // The city letters are not fully covered (B=11 and P=25 expand to digit
    // pairs Luhn cannot tell apart); they come from a short fixed list of
    // hub codes, so a typo there fails the lookup instead.
    let caught = 0;
    let total = 0;
    for (let index = 2; index < 5; index += 1) {
      for (const char of alphabet.slice(10)) {
        if (char === awb[index]) continue;
        total += 1;
        if (!isValidAwb(awb.slice(0, index) + char + awb.slice(index + 1))) caught += 1;
      }
    }
    assert.ok(caught / total > 0.7, `${caught}/${total}`);
  });

  it('detects adjacent-digit swaps', () => {
    const awb = buildAwb({ cityCode: 'DEL', date: new Date('2026-01-15T06:00:00Z'), sequence: 123456 });
    let detected = 0;
    let total = 0;
    for (let index = 5; index < awb.length - 2; index += 1) {
      if (awb[index] === awb[index + 1]) continue;
      total += 1;
      const swapped = awb.slice(0, index) + awb[index + 1] + awb[index] + awb.slice(index + 2);
      if (!isValidAwb(swapped)) detected += 1;
    }
    // Luhn misses only the 0↔9 swap.
    assert.ok(detected >= total - 1, `${detected}/${total}`);
  });
});

describe('AWB format', () => {
  it('is ZB + city + YYMMDD + 6-digit sequence + check digit', () => {
    const awb = buildAwb({ cityCode: 'BLR', date: new Date('2026-10-03T06:00:00Z'), sequence: 7 });
    assert.equal(awb.length, AWB_LENGTH);
    assert.match(awb, /^ZBBLR261003000007\d$/);
    assert.equal(awb.slice(-1), computeAwbCheckDigit(awb.slice(0, -1)));
  });

  it('uses the local (IST) date, not UTC', () => {
    // 20:00 UTC on Oct 3 is 01:30 IST on Oct 4.
    assert.equal(formatAwbDate(new Date('2026-10-03T20:00:00Z'), 330), '261004');
    assert.equal(formatAwbDate(new Date('2026-10-03T20:00:00Z'), 0), '261003');
  });

  it('refuses sequences that do not fit', () => {
    assert.throws(() => buildAwb({ cityCode: 'BLR', sequence: 0 }));
    assert.throws(() => buildAwb({ cityCode: 'BLR', sequence: 1_000_000 }));
    assert.throws(() => buildAwb({ cityCode: 'BLR', sequence: 1.5 }));
  });

  it('derives a 3-letter city code', () => {
    assert.equal(normalizeCityCode('blr'), 'BLR');
    assert.equal(normalizeCityCode('Bangalore'), 'BNG');
    assert.equal(normalizeCityCode('Indore'), 'IND');
    assert.equal(normalizeCityCode('Ab'), 'ABX');
    assert.equal(normalizeCityCode(''), 'XXX');
  });

  it('validates shape as well as checksum', () => {
    assert.equal(isValidAwb('ZBBLR26100300000'), false);
    assert.equal(isValidAwb('XXBLR2610030000071'), false);
    assert.equal(isValidAwb(null), false);
  });
});

describe('scanner input', () => {
  const awb = buildAwb({ cityCode: 'BLR', date: new Date('2026-10-03T06:00:00Z'), sequence: 42 });

  it('pulls the AWB out of a QR tracking URL, padded wedge input or lower case', () => {
    assert.equal(extractAwbFromScan(`https://track.example.com/t/${awb}`), awb);
    assert.equal(extractAwbFromScan(`  ${awb.toLowerCase()}\r\n`), awb);
    assert.equal(extractAwbFromScan(awb), awb);
  });

  it('QR payload is the tracking URL when configured, else the AWB', () => {
    assert.equal(buildQrPayload(awb, 'https://x.test/track/'), `https://x.test/track/${awb}`);
    assert.equal(buildQrPayload(awb, ''), awb);
  });
});
