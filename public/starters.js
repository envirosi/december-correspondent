// Fills the letter form from a chosen starter and highlights the first [gap] to fill in.
(function () {
  var data = document.getElementById('starter-data');
  var pick = document.getElementById('starter');
  var body = document.getElementById('body');
  var byline = document.getElementById('byline');
  if (!data || !pick || !body) return;
  var starters = JSON.parse(data.textContent);
  pick.addEventListener('change', function () {
    var s = starters[Number(pick.value)];
    if (!s) return;
    if (body.value.trim() && !confirmReplace()) { pick.value = ''; return; }
    body.value = s.body;
    if (byline && !byline.value) byline.value = 'Si';
    body.focus();
    var i = body.value.indexOf('['), j = body.value.indexOf(']', i);
    if (i >= 0 && j > i) body.setSelectionRange(i, j + 1);
  });
  // No browser dialogs: a second choice only replaces text that came from a starter.
  var last = '';
  function confirmReplace() { var ok = body.value === last || !body.value.trim(); return ok; }
  pick.addEventListener('change', function () { last = body.value; });
})();
