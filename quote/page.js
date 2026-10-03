/* Quote request: the live form's behaviour, without a framework.
   - Validation: browser-native, as on the live form; the browser's own message is also printed
     under the field and tied to it with aria-describedby.
   - "Not sure" buttons put "Not sure" in their field. Choosing Mail under Pickup–delivery–mail
     brings in the two mailing fields; choosing anything else takes them out again.
   - Files: the live picker's checks, in the live order and wording: 10 files, the accepted
     extensions, 50 MB each, 250 MB together, and the file's first bytes must match its extension.
   - Sending: the live protocol against https://www.citygi.com: POST /api/quote/session, then
     POST /api/quote with the form, quoteId, manifestToken and uploadedPathnames. The file upload
     step between them runs through a third-party upload SDK, so a request with files attached is
     handed to the live quote page instead. Network failures show the live error and a link there. */
(function () {
  'use strict';

  var ORIGIN = 'https://www.citygi.com';
  var LIVE_PAGE = ORIGIN + '/quote';
  var FALLBACK = "We couldn't send your request. Call us at (503) 222-2942 or email sendjob@citygi.com.";
  var MAX_FILES = 10;
  var MAX_FILE = 52428800;       /* 50 MB */
  var MAX_TOTAL = 262144000;     /* 250 MB */
  var ACCEPTED = ['pdf', 'ai', 'eps', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'zip'];

  var doc = document;
  var form = doc.getElementById('quote-form');
  if (!form) return;

  var status = doc.getElementById('quote-status');
  var submit = doc.getElementById('quote-submit');
  var drop = doc.getElementById('files-drop');
  var picker = doc.getElementById('files');
  var cta = doc.getElementById('files-cta');
  var list = doc.getElementById('file-list');
  var fulfillment = doc.getElementById('fulfillment');
  var mailFields = form.querySelectorAll('[data-mail]');

  var files = [];       /* { file, progress, status } */
  var session = null;   /* the prepared quote session, kept for a retry */
  var busy = false;

  /* ---------------------------------------------------------------- status line */

  var say = function (message, kind, handOff) {
    status.textContent = '';
    if (kind) status.setAttribute('data-state', kind);
    else status.removeAttribute('data-state');
    if (!message) return;
    var text = doc.createElement('span');
    text.textContent = message;
    if (handOff) {
      var a = doc.createElement('a');
      a.href = LIVE_PAGE;
      a.textContent = handOff;
      text.appendChild(doc.createTextNode(' '));
      text.appendChild(a);
    }
    status.appendChild(text);
  };

  /* ---------------------------------------------------------------- field errors */

  var errorFor = function (el) { return el.id ? doc.getElementById(el.id + '-error') : null; };

  form.addEventListener('invalid', function (e) {
    var el = e.target;
    el.setAttribute('aria-invalid', 'true');
    var out = errorFor(el);
    if (out) out.textContent = el.validationMessage;
  }, true);

  var recheck = function (e) {
    var el = e.target;
    if (el.getAttribute('aria-invalid') !== 'true') return;
    var out = errorFor(el);
    if (el.validity.valid) {
      el.removeAttribute('aria-invalid');
      if (out) out.textContent = '';
    } else if (out) {
      out.textContent = el.validationMessage;
    }
  };
  form.addEventListener('input', recheck);
  form.addEventListener('change', recheck);

  /* ---------------------------------------------------------------- "Not sure" and mailing fields */

  form.addEventListener('click', function (e) {
    var button = e.target.closest && e.target.closest('[data-not-sure]');
    if (!button) return;
    var input = doc.getElementById(button.getAttribute('data-not-sure'));
    if (!input) return;
    input.value = 'Not sure';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  var syncMail = function () {
    var on = fulfillment.value === 'Mail';
    for (var i = 0; i < mailFields.length; i++) {
      var input = mailFields[i].querySelector('input');
      mailFields[i].hidden = !on;
      input.disabled = !on;
      if (!on) input.value = '';
    }
  };
  fulfillment.addEventListener('change', syncMail);
  syncMail();

  /* ---------------------------------------------------------------- files */

  var startsWith = function (bytes, sig) {
    for (var i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
    return true;
  };

  var contentsMatch = function (ext, b) {
    var pdf = startsWith(b, [37, 80, 68, 70, 45]);   /* %PDF- */
    var ps = startsWith(b, [37, 33, 80, 83]);        /* %!PS */
    if (ext === 'pdf') return pdf;
    if (ext === 'ai') return pdf || ps;
    if (ext === 'eps') return ps;
    if (ext === 'jpg' || ext === 'jpeg') return startsWith(b, [255, 216, 255]);
    if (ext === 'png') return startsWith(b, [137, 80, 78, 71, 13, 10, 26, 10]);
    if (ext === 'tif' || ext === 'tiff') return startsWith(b, [73, 73, 42, 0]) || startsWith(b, [77, 77, 0, 42]);
    if (ext === 'zip') return startsWith(b, [80, 75, 3, 4]) || startsWith(b, [80, 75, 5, 6]) || startsWith(b, [80, 75, 7, 8]);
    return false;
  };

  var readHead = function (file) {
    var slice = file.slice(0, 16);
    if (slice.arrayBuffer) return slice.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsArrayBuffer(slice);
    });
  };

  var formatSize = function (n) {
    return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  };

  var renderFiles = function () {
    var full = files.length >= MAX_FILES;
    cta.textContent = full ? 'File limit reached' : 'Choose files';
    picker.disabled = busy || full;
    drop.classList.toggle('is-full', full);

    list.textContent = '';
    list.hidden = !files.length;
    files.forEach(function (entry, index) {
      var li = doc.createElement('li');
      li.className = 'file-item';

      var meta = doc.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = entry.file.name + ' · ' + formatSize(entry.file.size);

      var state = doc.createElement('span');
      state.className = 'file-status';
      state.appendChild(doc.createTextNode(entry.status));
      if (!busy) {
        state.appendChild(doc.createTextNode(' · '));
        var remove = doc.createElement('button');
        remove.type = 'button';
        remove.className = 'chip';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', 'Remove ' + entry.file.name);
        remove.addEventListener('click', function () {
          if (busy) return;
          session = null;
          files = files.filter(function (f, i) { return i !== index; });
          renderFiles();
          picker.focus();
        });
        state.appendChild(remove);
      }

      var bar = doc.createElement('progress');
      bar.max = 100;
      bar.value = entry.progress;
      bar.setAttribute('aria-label', entry.file.name + ' upload progress');

      li.appendChild(meta);
      li.appendChild(state);
      li.appendChild(bar);
      list.appendChild(li);
    });
  };

  var addFiles = async function (incoming) {
    var picked = Array.prototype.slice.call(incoming || []);
    var next = files.slice();
    var errors = [];
    session = null;

    for (var i = 0; i < picked.length; i++) {
      var file = picked[i];
      if (next.length >= MAX_FILES) {
        errors.push(file.name + ': only 10 files can be attached.');
        continue;
      }
      var ext = file.name.toLowerCase().split('.').pop() || '';
      if (ACCEPTED.indexOf(ext) === -1) {
        errors.push(file.name + ': that file type is not accepted.');
        continue;
      }
      if (file.size > MAX_FILE) {
        errors.push(file.name + ': each file must be 50 MB or smaller.');
        continue;
      }
      var total = next.reduce(function (sum, f) { return sum + f.file.size; }, 0);
      if (total + file.size > MAX_TOTAL) {
        errors.push(file.name + ': all files together must be 250 MB or smaller.');
        continue;
      }
      var head = new Uint8Array(await readHead(file));
      if (!contentsMatch(ext, head)) {
        errors.push(file.name + ': the file contents do not match the filename extension.');
        continue;
      }
      next.push({ file: file, progress: 0, status: 'Ready' });
    }

    files = next;
    renderFiles();
    if (errors.length) say(errors.join(' '), 'error');
    else say(files.length ? files.length + ' file' + (files.length === 1 ? '' : 's') + ' ready.' : '', '');
  };

  picker.addEventListener('change', function () {
    var picked = Array.prototype.slice.call(picker.files || []);
    picker.value = '';
    addFiles(picked);
  });

  var over = function (e) {
    e.preventDefault();
    drop.classList.add('is-over');
  };
  drop.addEventListener('dragenter', over);
  drop.addEventListener('dragover', over);
  drop.addEventListener('dragleave', function (e) {
    if (!drop.contains(e.relatedTarget)) drop.classList.remove('is-over');
  });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('is-over');
    if (!busy && files.length < MAX_FILES && e.dataTransfer) addFiles(e.dataTransfer.files);
  });

  /* ---------------------------------------------------------------- sending */

  var readJson = async function (response) {
    try { return await response.json(); } catch (err) { return {}; }
  };

  /* A 4xx means the prepared session is spent: start over on the next try. */
  var resetSession = function () {
    session = null;
    files = files.map(function (f) { return { file: f.file, progress: 0, status: 'Ready' }; });
  };

  var setBusy = function (on) {
    busy = on;
    if (on) submit.setAttribute('aria-busy', 'true');
    else submit.removeAttribute('aria-busy');
    renderFiles();
  };

  var confirm = function (quoteId) {
    var box = doc.createElement('div');
    box.className = 'confirm';
    box.setAttribute('role', 'status');
    box.tabIndex = -1;

    var h2 = doc.createElement('h2');
    h2.textContent = 'Got it — thanks.';
    box.appendChild(h2);

    var id = doc.createElement('p');
    id.className = 'confirm-id';
    var strong = doc.createElement('strong');
    strong.className = 'tnum';
    strong.textContent = quoteId;
    id.appendChild(strong);
    box.appendChild(id);

    var note = doc.createElement('p');
    note.className = 'confirm-note';
    note.textContent = "Submitting a request doesn't confirm schedule, pricing, or acceptance — a real person will confirm all three.";
    box.appendChild(note);

    form.parentNode.replaceChild(box, form);
    box.focus();
  };

  var send = async function () {
    if (files.length) {
      say('File uploads run on the live quote page.', 'error', 'Send your request and files at citygi.com/quote');
      status.scrollIntoView({ block: 'nearest' });
      return;
    }

    setBusy(true);
    say('Preparing your quote request…', 'pending');

    try {
      var fd = new FormData(form);
      var get = function (key) { return String(fd.get(key) || ''); };
      var data = {
        name: get('name'),
        company: get('company'),
        email: get('email'),
        phone: get('phone'),
        projectDescription: get('projectDescription'),
        quantity: get('quantity'),
        flatSize: get('flatSize'),
        finishedSize: get('finishedSize'),
        pagesSheets: get('pagesSheets'),
        paperStock: get('paperStock'),
        color: get('color'),
        finishing: fd.getAll('finishing').map(String),
        artworkStatus: get('artworkStatus'),
        fulfillment: get('fulfillment'),
        mailingQuantity: get('mailingQuantity'),
        mailingDestination: get('mailingDestination'),
        requestedInHandsDate: get('requestedInHandsDate'),
        specialInstructions: get('specialInstructions'),
        website: get('website')
      };

      var prepared = session;
      if (!prepared) {
        var opened = await fetch(ORIGIN + '/api/quote/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            website: data.website,
            files: files.map(function (f) { return { name: f.file.name, size: f.file.size }; })
          })
        });
        prepared = await readJson(opened);
        if (!opened.ok) {
          if (opened.status >= 400 && opened.status < 500) resetSession();
          throw new Error(prepared.message || "We couldn't prepare your upload.");
        }
        prepared.uploadedPathnames = new Array(files.length).fill('');
        session = prepared;
      }

      say('Sending your quote request…', 'pending');

      var payload = {};
      for (var key in data) payload[key] = data[key];
      payload.quoteId = prepared.quoteId;
      payload.manifestToken = prepared.manifestToken;
      payload.uploadedPathnames = prepared.uploadedPathnames;

      var sent = await fetch(ORIGIN + '/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var result = await readJson(sent);
      if (!sent.ok) {
        if (sent.status >= 400 && sent.status < 500) resetSession();
        throw new Error(result.message || "We couldn't send your request.");
      }

      session = null;
      say('Quote request received.', 'success');
      /* As on the live page, the ticket replaces the form once the shop returns a request number. */
      if (result.quoteId) confirm(result.quoteId);
    } catch (err) {
      /* fetch() rejects with a TypeError when the network or the browser blocks the request. */
      var message = err instanceof Error && !(err instanceof TypeError) ? err.message : FALLBACK;
      say(message, 'error', 'Open the live quote page');
    } finally {
      setBusy(false);
    }
  };

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!busy) send();
  });

  renderFiles();
})();
