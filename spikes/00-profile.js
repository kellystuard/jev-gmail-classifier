/**
 * s00_profile: trivial spike confirming the Advanced Gmail Service is wired
 * up (manifest, scopes, enabled service) and returning a usable position.
 *
 * Never include emailAddress in the result: the test account's address is
 * never written anywhere (findings use `<test-account>`).
 */
function s00_profile() {
  var profile = Gmail.Users.getProfile('me');
  var result = {
    historyId: profile.historyId,
    messagesTotal: profile.messagesTotal,
    threadsTotal: profile.threadsTotal
  };
  console.log(JSON.stringify(result));
  return result;
}
