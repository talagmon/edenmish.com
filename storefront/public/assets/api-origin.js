(function () {
  var host = window.location.hostname.toLowerCase();
  var local = host === 'localhost' || host === '127.0.0.1';
  var staging = host === 'staging.edenmish.com' || host.endsWith('.pages.dev');
  var localOrigin = window.location.protocol + '//localhost:8787';

  window.EDEN_API = Object.freeze({
    find: local ? localOrigin : staging ? 'https://find-staging.edenmish.com' : 'https://find.edenmish.com',
    ops: local ? localOrigin : staging ? 'https://ops-staging.edenmish.com' : 'https://ops.edenmish.com',
    environment: local ? 'local' : staging ? 'staging' : 'production',
  });
})();
