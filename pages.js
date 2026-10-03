/* City Graphics: shared behaviour for every page except the film home. No dependencies.
   - Menu: the small-screen menu is a <details> element and works without this script; here it
     also closes on Escape (focus back on the toggle), on a click outside, when a link in it is
     followed, when focus leaves it, and when the screen widens to the full navigation.
   - Current page: links to the page being read get aria-current="page", unless the page
     already marks its own.
   - Press bar: browsers without scroll-driven animations get the header's reading-progress
     colour bar from script. */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  /* ---------------------------------------------------------------- menu */

  var menu = doc.querySelector('.site-head .menu');
  if (menu) {
    var toggle = menu.querySelector('summary');

    var close = function (returnFocus) {
      if (!menu.open) return;
      menu.open = false;
      if (returnFocus && toggle) toggle.focus();
    };

    doc.addEventListener('keydown', function (e) {
      if (menu.open && (e.key === 'Escape' || e.key === 'Esc')) {
        e.preventDefault();
        close(true);
      }
    });

    doc.addEventListener('click', function (e) {
      if (menu.open && !menu.contains(e.target)) close(false);
    });

    menu.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.menu-panel a')) close(false);
    });

    menu.addEventListener('focusout', function (e) {
      if (menu.open && e.relatedTarget && !menu.contains(e.relatedTarget)) close(false);
    });

    var wide = window.matchMedia('(min-width: 1080px)');
    var onWide = function (e) { if (e.matches) close(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide);
    else if (wide.addListener) wide.addListener(onWide);
  }

  /* ---------------------------------------------------------------- current page */

  var normalise = function (path) {
    path = path.replace(/index\.html?$/i, '');
    return path.charAt(path.length - 1) === '/' ? path : path + '/';
  };
  var here = normalise(location.pathname);

  var markCurrent = function (scope) {
    if (!scope || scope.querySelector('[aria-current]')) return;
    var links = scope.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.getAttribute('href').charAt(0) === '#') continue;
      if (a.protocol !== location.protocol || a.host !== location.host) continue;
      if (normalise(a.pathname) === here) a.setAttribute('aria-current', 'page');
    }
  };

  var head = doc.querySelector('.site-head');
  if (head) {
    var headCta = head.querySelector('.btn--chrome');
    if (headCta && !head.querySelector('[aria-current]') &&
        headCta.protocol === location.protocol && headCta.host === location.host &&
        normalise(headCta.pathname) === here) {
      headCta.setAttribute('aria-current', 'page');
    }
    markCurrent(head.querySelector('.nav'));
    markCurrent(head.querySelector('.menu-panel'));
  }
  markCurrent(doc.querySelector('.site-foot .foot-nav'));

  /* ---------------------------------------------------------------- press bar */

  var bar = doc.querySelector('.site-head .press-bar');
  var hasTimeline = window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()');
  if (bar && !hasTimeline) {
    bar.classList.add('is-js');
    var queued = false;
    var paint = function () {
      queued = false;
      var travel = root.scrollHeight - window.innerHeight;
      var progress = travel > 1 ? Math.min(1, Math.max(0, window.pageYOffset / travel)) : 1;
      bar.style.setProperty('--progress', progress.toFixed(4));
    };
    var queue = function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(paint);
    };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    paint();
  }
})();
