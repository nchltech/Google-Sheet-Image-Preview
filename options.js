// Options page script
(function () {
  var defaults = {
    overlayEnabled: true,
    showOpenOriginalButton: true,
    ttl: 8000,
    ttlSeen: 60000,
    iconSize: 13
  };

  function $(id) { return document.getElementById(id); }

  function load() {
    chrome.storage.sync.get(defaults, function (items) {
      $('overlayEnabled').checked = !!items.overlayEnabled;
      $('showOpenOriginalButton').checked = items.showOpenOriginalButton !== false;
      $('ttl').value = items.ttl;
      $('ttlSeen').value = items.ttlSeen;
      $('iconSize').value = items.iconSize;
    });
  }

  function save() {
    var items = {
      overlayEnabled: $('overlayEnabled').checked,
      showOpenOriginalButton: $('showOpenOriginalButton').checked,
      ttl: parseInt($('ttl').value, 10) || defaults.ttl,
      ttlSeen: parseInt($('ttlSeen').value, 10) || defaults.ttlSeen,
      iconSize: parseInt($('iconSize').value, 10) || defaults.iconSize
    };
    chrome.storage.sync.set(items, function () {
      var status = $('status');
      if (status) {
        status.textContent = 'Options saved.';
        setTimeout(function () { status.textContent = ''; }, 1800);
      }
    });
  }

  window.addEventListener('DOMContentLoaded', function () {
    load();
    ['overlayEnabled','showOpenOriginalButton','ttl','ttlSeen','iconSize'].forEach(function (id) {
      $(id).addEventListener('change', save);
    });
  });
})();
