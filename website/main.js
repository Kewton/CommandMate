/* CommandMate landing page behaviour (Issue #1200).
   Two jobs: copy-to-clipboard on the install commands, and starting the feature
   demos — only once they are on screen (Issue #2556), and never for a reader
   who asked for reduced motion (Issue #1577). No dependencies, no build step. */

(function () {
  'use strict';

  /* ---------- demo playback: lazy (Issue #2556), motion-safe (Issue #1577) ---------- */

  // The demos carry `data-autoplay` rather than `autoplay`, because the real
  // attribute outranks `preload="none"`: with it, all five downloaded on first
  // load whether or not anyone scrolled that far. So playback starts here.
  var VISIBLE_RATIO = 0.25;
  var demos = document.querySelectorAll('video[data-autoplay]');

  // A blocked autoplay rejects the promise and leaves the poster up. That is
  // the whole failure, so it is not worth an error in the reader's console.
  function play(video) {
    var started = video.play();
    if (started && typeof started.catch === 'function') {
      started.catch(function () {});
    }
  }

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion && reduceMotion.matches) {
    // Nothing starts on its own; `controls` is what leaves the reader a way to
    // watch on purpose.
    Array.prototype.forEach.call(demos, function (video) {
      video.removeAttribute('data-autoplay');
      video.loop = false;
      video.controls = true;
    });
  } else if ('IntersectionObserver' in window) {
    // Play at a quarter visible and pause below it, so a demo scrolled past
    // does not go on looping off screen. The observer reports every
    // demo once on `observe`; the `paused` check keeps that first report from
    // calling pause() on a video that never started, which on an element with
    // nothing loaded yet runs resource selection.
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var video = entry.target;
          if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO) {
            play(video);
          } else if (!video.paused) {
            video.pause();
          }
        });
      },
      { threshold: VISIBLE_RATIO },
    );
    Array.prototype.forEach.call(demos, function (video) {
      observer.observe(video);
    });
  } else {
    // No observer to wait for: play at once, as the `autoplay` attribute did.
    Array.prototype.forEach.call(demos, play);
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
