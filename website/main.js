/* CommandMate landing page behaviour (Issue #1200).
   Two jobs only: copy-to-clipboard on the install commands, and motion-safe
   video playback. No dependencies, no build step. */

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

  /* ---------- motion-safe autoplay ---------- */

  // The markup carries no autoplay attribute on purpose. Starting playback from
  // here means prefers-reduced-motion is honoured before a single frame runs,
  // rather than pausing after the fact and flashing motion at people who asked
  // for none. With JS off, the poster stays up and nothing is lost.
  var videos = document.querySelectorAll('video[data-autoplay]');
  if (!videos.length || typeof window.matchMedia !== 'function') return;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var visible = typeof WeakSet === 'function' ? new WeakSet() : null;

  function shouldPlay(video) {
    return !reduceMotion.matches && (!visible || visible.has(video));
  }

  function sync(video) {
    if (!shouldPlay(video)) {
      video.pause();
      return;
    }
    var attempt = video.play();
    // Autoplay can still be refused (e.g. iOS Low Power Mode). Surface controls
    // rather than leaving a frozen frame with no way to start it.
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(function () {
        video.setAttribute('controls', '');
      });
    }
  }

  function syncAll() {
    Array.prototype.forEach.call(videos, function (video) {
      // Reduced motion gets a poster plus controls, so the demo is still
      // reachable on purpose rather than simply withheld.
      if (reduceMotion.matches) {
        video.setAttribute('controls', '');
      } else {
        video.removeAttribute('controls');
      }
      sync(video);
    });
  }

  // Play only what is on screen. Calling play() forces a full download, so
  // without this the below-the-fold phone demo would pull ~1.1MB on load and
  // make its preload="none" meaningless.
  if (typeof window.IntersectionObserver === 'function' && visible) {
    var observer = new window.IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            visible.add(entry.target);
          } else {
            visible.delete(entry.target);
          }
          sync(entry.target);
        });
      },
      { rootMargin: '200px 0px' },
    );
    Array.prototype.forEach.call(videos, function (video) {
      observer.observe(video);
    });
  } else {
    visible = null; // No observer: fall back to playing whenever motion allows.
    syncAll();
  }

  if (typeof reduceMotion.addEventListener === 'function') {
    reduceMotion.addEventListener('change', syncAll);
  } else if (typeof reduceMotion.addListener === 'function') {
    reduceMotion.addListener(syncAll); // Safari < 14
  }
})();
