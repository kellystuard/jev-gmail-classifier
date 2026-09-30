/**
 * s99: does Apps Script's V8 give the same `YYYY-MM-DD` as Node for
 * `Intl.DateTimeFormat` with a `timeZone`? (Task #99, story #98, epic #11
 * decision 10.) The product's `dayInTimeZone` (src/core/token-budget.ts) uses
 * `Intl.DateTimeFormat` with `formatToParts`. Apps Script's ICU data could be
 * smaller than Node's, so this compares it, per instant and zone, with
 * `Utilities.formatDate`, Apps Script's own reference.
 *
 * Runnable functions (each returns a JSON-serializable result and logs it):
 *   s99_days(args)   args is optional: {instants: [epochMs, ...], zones: [...]}.
 *                    With no args, checks the default cases below. With
 *                    `instants` and no `zones`, it uses the default zones.
 *
 * No Gmail call, no Script Property, no trigger. Conventions: spikes/README.md.
 */

var s99_DEFAULT_ZONES = [
  'Etc/UTC',
  'America/Chicago',
  'Asia/Kolkata',
  'Pacific/Kiritimati',
  'Australia/Lord_Howe',
  'Pacific/Pago_Pago',
];

/** Instants (ISO, UTC) of local midnight on 2026-09-29 in each zone, and other cases. */
var s99_DEFAULT_CASES = [
  // [zone, UTC instant of the local moment, label]
  ['Etc/UTC', '2026-09-29T00:00:00Z', 'midnight 2026-09-29'],
  ['America/Chicago', '2026-09-29T05:00:00Z', 'midnight 2026-09-29 (UTC-5)'],
  ['Asia/Kolkata', '2026-09-28T18:30:00Z', 'midnight 2026-09-29 (UTC+5:30)'],
  ['Pacific/Kiritimati', '2026-09-28T10:00:00Z', 'midnight 2026-09-29 (UTC+14)'],
  ['Australia/Lord_Howe', '2026-09-28T13:30:00Z', 'midnight 2026-09-29 (UTC+10:30)'],
  ['Pacific/Pago_Pago', '2026-09-29T11:00:00Z', 'midnight 2026-09-29 (UTC-11)'],
  // DST days in America/Chicago: 2026-03-08 (spring forward, 2:00 CST) and 2026-11-01 (fall back, 2:00 CDT)
  ['America/Chicago', '2026-03-08T06:00:00Z', 'midnight 2026-03-08 (UTC-6)'],
  ['America/Chicago', '2026-03-08T08:00:00Z', 'the spring-forward gap (02:00 CST)'],
  ['America/Chicago', '2026-03-09T05:00:00Z', 'midnight 2026-03-09 (UTC-5)'],
  ['America/Chicago', '2026-11-01T05:00:00Z', 'midnight 2026-11-01 (UTC-5)'],
  ['America/Chicago', '2026-11-01T07:00:00Z', 'the fall-back hour (02:00 CDT to 01:00 CST)'],
  ['America/Chicago', '2026-11-02T06:00:00Z', 'midnight 2026-11-02 (UTC-6)'],
];

/** The algorithm of src/core/token-budget.ts `dayInTimeZone`, as plain JS. */
function s99_intlDay_(epochMs, timeZone) {
  var formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  var parts = {};
  formatter.formatToParts(new Date(epochMs)).forEach(function (part) {
    parts[part.type] = part.value;
  });
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function s99_row_(zone, epochMs, label) {
  var intlDay;
  var referenceDay;
  try {
    intlDay = s99_intlDay_(epochMs, zone);
  } catch (e) {
    intlDay = 'ERROR ' + e.name + ': ' + e.message;
  }
  try {
    referenceDay = Utilities.formatDate(new Date(epochMs), zone, 'yyyy-MM-dd');
  } catch (e) {
    referenceDay = 'ERROR ' + e.name + ': ' + e.message;
  }
  return {
    zone: zone,
    epochMs: epochMs,
    instant: new Date(epochMs).toISOString(),
    label: label,
    intlDay: intlDay,
    formatDateDay: referenceDay,
    agree: intlDay === referenceDay,
  };
}

function s99_days(args) {
  var rows = [];
  if (args && args.instants) {
    var zones = args.zones || s99_DEFAULT_ZONES;
    args.instants.forEach(function (ms) {
      zones.forEach(function (zone) {
        rows.push(s99_row_(zone, ms, 'given'));
      });
    });
  } else if (args && args.zones) {
    s99_DEFAULT_CASES.forEach(function (c) {
      args.zones.forEach(function (zone) {
        rows.push(s99_row_(zone, Date.parse(c[1]), c[2]));
      });
    });
  } else {
    s99_DEFAULT_CASES.forEach(function (c) {
      var ms = Date.parse(c[1]);
      rows.push(s99_row_(c[0], ms - 60000, 'one minute before ' + c[2]));
      rows.push(s99_row_(c[0], ms, c[2]));
      rows.push(s99_row_(c[0], ms + 60000, 'one minute after ' + c[2]));
    });
  }

  var invalid;
  try {
    s99_intlDay_(Date.parse('2026-09-29T00:00:00Z'), 'Not/AZone');
    invalid = { threw: false };
  } catch (e) {
    invalid = { threw: true, name: e.name, message: e.message };
  }
  var invalidFormatDate;
  try {
    Utilities.formatDate(new Date(0), 'Not/AZone', 'yyyy-MM-dd');
    invalidFormatDate = { threw: false };
  } catch (e) {
    invalidFormatDate = { threw: true, name: e.name, message: e.message };
  }

  var result = {
    scriptTimeZone: Session.getScriptTimeZone(),
    intlResolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rowCount: rows.length,
    allAgree: rows.every(function (r) {
      return r.agree;
    }),
    disagreements: rows.filter(function (r) {
      return !r.agree;
    }),
    invalidZoneIntl: invalid,
    invalidZoneFormatDate: invalidFormatDate,
    rows: rows,
  };
  console.log(JSON.stringify(result));
  return result;
}
