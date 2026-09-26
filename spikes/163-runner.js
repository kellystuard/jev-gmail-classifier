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
  var found = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getUniqueId() === id;
  });
  ScriptApp.deleteTrigger(trigger);
  var left = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction().indexOf('s163_') === 0;
  }).length;
  var result = { created: true, found: found, deleted: left === 0 };
  console.log(JSON.stringify(result));
  return result;
}

/** Handler for s163_trigger's trigger; it is deleted before it can fire. */
function s163_noop() {}
