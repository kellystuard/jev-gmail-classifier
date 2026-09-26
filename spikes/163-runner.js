/**
 * Self-checks for the spike runner (#163). Findings are in spikes/00-profile.md
 * and spikes/README.md ("Running spikes automatically").
 */

/**
 * s163_echo: returns its argument, to check parameter passing through
 * scripts.run, plus `bytes` characters of padding, to probe the size of
 * return value the Apps Script API passes back.
 */
function s163_echo(input) {
  input = input || {};
  var result = { received: input, paddingBytes: input.bytes || 0 };
  if (input.bytes) result.padding = 'x'.repeat(input.bytes);
  console.log(JSON.stringify({ received: input, paddingBytes: result.paddingBytes }));
  return result;
}

/**
 * s163_trigger: creates a time-driven trigger for s163_noop, confirms it
 * exists, and deletes it again, to show that spikes (#21, #23) can manage
 * their own triggers through scripts.run. Touches only s163_ triggers.
 */
function s163_trigger() {
  var trigger = ScriptApp.newTrigger('s163_noop').timeBased().everyHours(1).create();
  var id = trigger.getUniqueId();
  var fresh = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getUniqueId() === id;
  });
  var found = fresh.length === 1;
  // Deleting the object returned by create() in the same execution fails
  // ("Unexpected error while getting the method or property deleteTrigger"),
  // so delete the copy returned by getProjectTriggers() instead.
  fresh.forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  var left = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction().indexOf('s163_') === 0;
  }).length;
  var result = { created: true, found: found, deleted: left === 0 };
  console.log(JSON.stringify(result));
  return result;
}

/**
 * s163_triggerSteps: the same as s163_trigger, one step at a time, catching
 * each step's error, to find which call fails when s163_trigger does.
 * step: 'list' (default), 'create', or 'cleanup' (deletes s163_ triggers).
 */
function s163_triggerSteps(step) {
  step = step || 'list';
  var result = { step: step };
  function mine() {
    return ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction().indexOf('s163_') === 0;
    });
  }
  try {
    if (step === 'create') {
      var t = ScriptApp.newTrigger('s163_noop').timeBased().everyHours(1).create();
      result.createdId = t.getUniqueId();
    }
    if (step === 'roundtrip') {
      result.at = 'create';
      var rt = ScriptApp.newTrigger('s163_noop').timeBased().everyHours(1).create();
      result.at = 'getUniqueId';
      var rtId = rt.getUniqueId();
      result.at = 'find';
      result.found = mine().some(function (x) {
        return x.getUniqueId() === rtId;
      });
      result.at = 'delete';
      ScriptApp.deleteTrigger(rt);
      result.at = 'done';
    }
    if (step === 'cleanup') {
      var list = mine();
      list.forEach(function (t) {
        ScriptApp.deleteTrigger(t);
      });
      result.deleted = list.length;
    }
    result.s163Triggers = mine().length;
    result.allTriggers = ScriptApp.getProjectTriggers().length;
  } catch (e) {
    result.error = String(e && e.message ? e.message : e);
  }
  console.log(JSON.stringify(result));
  return result;
}

/** Handler for s163_trigger's trigger; it is deleted before it can fire. */
function s163_noop() {}
