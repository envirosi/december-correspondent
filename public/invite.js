// The invitation token lives in the URL fragment, which never reaches the server or its logs.
(function () {
  var t = (location.hash || '').replace(/^#/, '');
  var field = document.getElementById('token');
  if (t && field) {
    field.value = t;
    var paste = document.querySelector('.nojs-token');
    if (paste) paste.hidden = true;
    history.replaceState(null, '', location.pathname);
  }
})();
