/* Portals: the four-step portal demo, rebuilt from the live page's own script. No dependencies.
   - Steps: Your card → Your details → Approve your proof → Approved. The stepper marks the step
     on screen (aria-current="step") and the ones behind it. Moving forward puts focus on the new
     step's heading; Back and Start over return it to "Click here to test it".
   - Live proof: every card in the demo mirrors the details as they are typed, falling back to
     "Your name", "Your title", "Your phone" and "Your email" when a field is empty.
   - Details: the live fields' rules (all required; maxlength 52 / 62 / 32 / 72; a valid email),
     with the browser's own validation message shown and announced beside each field.
   - Nothing is sent anywhere, as on the live site. Start over restores the sample card. */
(function () {
  'use strict';

  var demo = document.getElementById('portal-demo');
  if (!demo) return;

  var KEYS = ['name', 'title', 'phone', 'email'];
  var SAMPLE = {
    name: 'Jordan Lee',
    title: 'Community Partnerships',
    phone: '(503) 555-0147',
    email: 'jordan@bridgecitysample.example'
  };
  var EMPTY = { name: 'Your name', title: 'Your title', phone: 'Your phone', email: 'Your email' };

  var panels = demo.querySelectorAll('.demo-panel[data-step]');
  var steps = demo.querySelectorAll('.stepper li');
  var form = demo.querySelector('form.demo-panel');
  var start = demo.querySelector('[data-start]');
  var fields = {};
  var details = {};
  var current = 1;

  KEYS.forEach(function (key) {
    fields[key] = form ? form.elements[key] : null;
    details[key] = fields[key] ? fields[key].value : SAMPLE[key];
  });

  /* ---------------------------------------------------------------- live proof */

  var paint = function () {
    KEYS.forEach(function (key) {
      var text = details[key] || EMPTY[key];
      var outs = demo.querySelectorAll('[data-bind="' + key + '"]');
      for (var i = 0; i < outs.length; i++) {
        if (outs[i].textContent !== text) outs[i].textContent = text;
      }
    });
  };

  /* ---------------------------------------------------------------- steps */

  var go = function (n) {
    var from = current;
    current = n;

    for (var i = 0; i < panels.length; i++) {
      panels[i].hidden = Number(panels[i].getAttribute('data-step')) !== n;
    }
    for (var j = 0; j < steps.length; j++) {
      var num = j + 1;
      steps[j].classList.toggle('is-done', num < n);
      if (num === n) steps[j].setAttribute('aria-current', 'step');
      else steps[j].removeAttribute('aria-current');
    }

    if (n > 1) {
      var panel = demo.querySelector('.demo-panel[data-step="' + n + '"]');
      var heading = panel && panel.querySelector('[data-focus]');
      if (heading) heading.focus();
    } else if (from !== 1 && start) {
      start.focus();
    }
  };

  /* ---------------------------------------------------------------- validation */

  var errorFor = function (input) {
    return document.getElementById(input.id + '-error');
  };
  var flag = function (input) {
    var out = errorFor(input);
    input.setAttribute('aria-invalid', 'true');
    if (out) out.textContent = input.validationMessage;
  };
  var unflag = function (input) {
    var out = errorFor(input);
    input.removeAttribute('aria-invalid');
    if (out) out.textContent = '';
  };
  var recheck = function (input) {
    if (input.getAttribute('aria-invalid') !== 'true') return;
    if (input.validity.valid) unflag(input);
    else flag(input);
  };

  if (form) {
    form.noValidate = true;

    form.addEventListener('input', function (e) {
      var input = e.target;
      if (!input.name || KEYS.indexOf(input.name) < 0) return;
      details[input.name] = input.value;
      paint();
      recheck(input);
    });

    form.addEventListener('focusout', function (e) {
      if (e.target.name && KEYS.indexOf(e.target.name) >= 0) recheck(e.target);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var first = null;
      KEYS.forEach(function (key) {
        var input = fields[key];
        if (!input) return;
        if (input.validity.valid) {
          unflag(input);
        } else {
          flag(input);
          if (!first) first = input;
        }
      });
      if (first) {
        first.focus();
        return;
      }
      go(3);
    });
  }

  /* ---------------------------------------------------------------- buttons */

  var reset = function () {
    KEYS.forEach(function (key) {
      details[key] = SAMPLE[key];
      if (fields[key]) {
        fields[key].value = SAMPLE[key];
        unflag(fields[key]);
      }
    });
    paint();
  };

  demo.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var to = e.target.closest('[data-go]');
    if (to) {
      go(Number(to.getAttribute('data-go')));
      return;
    }
    if (e.target.closest('[data-reset]')) {
      reset();
      go(1);
    }
  });

  paint();
})();
