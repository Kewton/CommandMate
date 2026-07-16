/* CommandMate landing page behaviour (Issue #1200).
   One job only: copy-to-clipboard on the install commands. The motion-safe
   video playback that used to live here went away with the demo videos
   (Issue #1272) — the page is static imagery now. No dependencies, no build
   step. */

(function () {
  'use strict';

  /* ---------- copy buttons ---------- */

  var COPIED_MS = 1600;

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Pages is HTTPS, so this only covers oddities like a file:// preview.
    return new Promise(function (resolve, reject) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy rejected'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(textarea);
      }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.copy-btn'), function (button) {
    var source = document.getElementById(button.getAttribute('data-copy-target'));
    var label = button.querySelector('[data-copy-label]');
    if (!source || !label) return;

    var idleLabel = label.textContent;
    var timer = null;

    button.addEventListener('click', function () {
      copyText(source.textContent.trim()).then(
        function () {
          label.textContent = 'Copied';
          button.setAttribute('data-copied', 'true');
        },
        function () {
          // Never claim success we did not get: tell the user to copy by hand.
          label.textContent = 'Press Ctrl+C';
        },
      );

      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        label.textContent = idleLabel;
        button.removeAttribute('data-copied');
      }, COPIED_MS);
    });
  });
})();
