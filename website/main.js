/* CommandMate landing page behaviour (Issue #1200).
   Two jobs: copy-to-clipboard on the install commands, and honouring
   prefers-reduced-motion for the feature demos (Issue #1577). No dependencies,
   no build step. */

(function () {
  'use strict';

  /* ---------- motion-safe demo playback (Issue #1577) ---------- */

  // CSS cannot stop an autoplaying video, so the attribute has to come off in
  // script. Dropping it alone is not enough once playback has begun, hence the
  // pause; `controls` is what leaves the reader a way to watch on purpose.
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion && reduceMotion.matches) {
    Array.prototype.forEach.call(document.querySelectorAll('video[autoplay]'), function (video) {
      video.autoplay = false;
      video.removeAttribute('autoplay');
      video.loop = false;
      video.controls = true;
      video.pause();
    });
  }

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

    // Only ever armed once the label has actually changed, so the countdown
    // measures how long the user saw the feedback rather than how long the
    // clipboard took to answer.
    function scheduleReset() {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        label.textContent = idleLabel;
        button.removeAttribute('data-copied');
      }, COPIED_MS);
    }

    button.addEventListener('click', function () {
      copyText(source.textContent.trim()).then(
        function () {
          label.textContent = 'Copied';
          button.setAttribute('data-copied', 'true');
          scheduleReset();
        },
        function () {
          // Never claim success we did not get: tell the user to copy by hand.
          label.textContent = 'Press Ctrl+C';
          scheduleReset();
        },
      );
    });
  });
})();
