(function () {
  "use strict";

  var trigger = document.getElementById("contactFab");
  var overlay = document.getElementById("contactModal");
  var dialog = overlay && overlay.querySelector(".contact-dialog");
  var closeButton = overlay && overlay.querySelector(".contact-modal-close");
  if (!trigger || !overlay || !dialog || !closeButton) return;

  var closeTimer = 0;
  var previousBodyOverflow = "";

  function openModal() {
    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    }
    previousBodyOverflow = document.body.style.overflow;
    overlay.hidden = false;
    document.body.classList.add("contact-modal-open");
    trigger.setAttribute("aria-expanded", "true");

    window.requestAnimationFrame(function () {
      overlay.classList.add("is-open");
      closeButton.focus();
    });
  }

  function closeModal(restoreFocus) {
    if (overlay.hidden) return;
    overlay.classList.remove("is-open");
    document.body.classList.remove("contact-modal-open");
    document.body.style.overflow = previousBodyOverflow;
    trigger.setAttribute("aria-expanded", "false");

    if (restoreFocus !== false) trigger.focus();

    if (closeTimer) window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(function () {
      overlay.hidden = true;
      closeTimer = 0;
    }, 230);
  }

  trigger.addEventListener("click", openModal);
  closeButton.addEventListener("click", function () {
    closeModal(true);
  });

  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closeModal(true);
  });

  document.addEventListener("keydown", function (event) {
    if (overlay.hidden) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeModal(true);
      return;
    }

    if (event.key !== "Tab") return;

    var focusable = Array.prototype.slice.call(
      dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
    ).filter(function (element) {
      return !element.hasAttribute("hidden") && element.getClientRects().length > 0;
    });

    if (!focusable.length) {
      event.preventDefault();
      closeButton.focus();
      return;
    }

    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
})();
