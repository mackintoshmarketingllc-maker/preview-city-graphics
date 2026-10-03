/* How to Save a Print-Ready PDF: the three tool notes (Canva, Word and PowerPoint, InDesign) are
   native <details>, closed on arrival as on the live page, and open and close without script.
   This only makes a printed copy of the guide carry all three notes, then puts each one back the
   way the reader left it. */
(function () {
  'use strict';

  var notes = document.querySelectorAll('.prose > details.disclosure');
  if (!notes.length) return;

  var openedForPrint = [];

  window.addEventListener('beforeprint', function () {
    openedForPrint = [];
    for (var i = 0; i < notes.length; i++) {
      if (!notes[i].open) {
        notes[i].open = true;
        openedForPrint.push(notes[i]);
      }
    }
  });

  window.addEventListener('afterprint', function () {
    for (var i = 0; i < openedForPrint.length; i++) openedForPrint[i].open = false;
    openedForPrint = [];
  });
})();
