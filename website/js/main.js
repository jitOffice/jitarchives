(function () {
  "use strict";

  var header = document.getElementById("siteHeader");
  var nav = document.getElementById("primaryNav");
  var navToggle = document.getElementById("navToggle");
  var ecosystemDropdown = document.querySelector(".nav-dropdown");
  var ecosystemToggle = document.getElementById("ecosystemToggle");
  var backToTop = document.getElementById("backToTop");
  var year = document.getElementById("currentYear");
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".primary-nav a"));

  if (year) year.textContent = String(new Date().getFullYear());

  function closeEcosystemDropdown() {
    if (!ecosystemDropdown || !ecosystemToggle) return;
    ecosystemDropdown.classList.remove("open");
    ecosystemToggle.setAttribute("aria-expanded", "false");
  }

  function toggleEcosystemDropdown() {
    if (!ecosystemDropdown || !ecosystemToggle) return;
    var willOpen = !ecosystemDropdown.classList.contains("open");
    ecosystemDropdown.classList.toggle("open", willOpen);
    ecosystemToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  function closeNav() {
    closeEcosystemDropdown();
    if (!nav || !navToggle) return;
    nav.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "打开导航菜单");
    var icon = navToggle.querySelector("img");
    if (icon) icon.src = "images/icons/menu.svg";
  }

  function toggleNav() {
    if (!nav || !navToggle) return;
    var willOpen = !nav.classList.contains("open");
    nav.classList.toggle("open", willOpen);
    navToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    navToggle.setAttribute("aria-label", willOpen ? "关闭导航菜单" : "打开导航菜单");
    var icon = navToggle.querySelector("img");
    if (icon) icon.src = willOpen ? "images/icons/close.svg" : "images/icons/menu.svg";
  }

  if (navToggle) navToggle.addEventListener("click", toggleNav);

  if (ecosystemToggle && ecosystemDropdown) {
    ecosystemToggle.addEventListener("click", function () {
      if (window.innerWidth <= 900) toggleEcosystemDropdown();
      else {
        ecosystemDropdown.classList.add("open");
        ecosystemToggle.setAttribute("aria-expanded", "true");
      }
    });

    ecosystemDropdown.addEventListener("mouseenter", function () {
      if (window.innerWidth > 900) {
        ecosystemDropdown.classList.add("open");
        ecosystemToggle.setAttribute("aria-expanded", "true");
      }
    });

    ecosystemDropdown.addEventListener("mouseleave", function () {
      if (window.innerWidth > 900) closeEcosystemDropdown();
    });

    ecosystemDropdown.addEventListener("focusin", function () {
      if (window.innerWidth > 900) {
        ecosystemDropdown.classList.add("open");
        ecosystemToggle.setAttribute("aria-expanded", "true");
      }
    });

    ecosystemDropdown.addEventListener("focusout", function (event) {
      if (!ecosystemDropdown.contains(event.relatedTarget)) {
        window.setTimeout(function () {
          if (!ecosystemDropdown.contains(document.activeElement)) closeEcosystemDropdown();
        }, 100);
      }
    });

    document.addEventListener("click", function (event) {
      if (!ecosystemDropdown.contains(event.target) && (!nav || !nav.contains(event.target))) {
        closeEcosystemDropdown();
      }
    });
  }

  if (nav) {
    nav.addEventListener("click", function (event) {
      var link = event.target.closest("a");
      if (link) window.setTimeout(closeNav, 0);
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeNav();
  });

  var scrollTicking = false;
  function updateScrollState() {
    var top = window.scrollY || window.pageYOffset || 0;
    if (header) header.classList.toggle("scrolled", top > 8);
    if (backToTop) backToTop.classList.toggle("visible", top > 520);
    scrollTicking = false;
  }

  window.addEventListener("scroll", function () {
    if (scrollTicking) return;
    scrollTicking = true;
    window.requestAnimationFrame(updateScrollState);
  }, { passive: true });
  updateScrollState();

  if (backToTop) {
    backToTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  var revealItems = document.querySelectorAll("[data-reveal]");
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var workflowTrack = document.querySelector(".workflow-track");
  if (workflowTrack) {
    var workflowIcons = Array.prototype.slice.call(workflowTrack.querySelectorAll(".workflow-step .step-icon"));
    var workflowObserver = null;
    var workflowResizeObserver = null;
    var workflowGeometryFrame = 0;
    var workflowAnimationFrame = 0;
    var workflowIsVisible = false;

    function updateWorkflowLineGeometry() {
      if (workflowIcons.length < 2) return;

      var trackRect = workflowTrack.getBoundingClientRect();
      var firstRect = workflowIcons[0].getBoundingClientRect();
      var lastRect = workflowIcons[workflowIcons.length - 1].getBoundingClientRect();
      if (!trackRect.width || !trackRect.height || !firstRect.width || !lastRect.width) return;

      var firstCenterX = firstRect.left + firstRect.width / 2 - trackRect.left;
      var firstCenterY = firstRect.top + firstRect.height / 2 - trackRect.top;
      var lastCenterX = lastRect.left + lastRect.width / 2 - trackRect.left;
      var lastCenterY = lastRect.top + lastRect.height / 2 - trackRect.top;
      var isVertical = window.matchMedia("(max-width: 680px)").matches;
      var lineLength = isVertical ? lastCenterY - firstCenterY : lastCenterX - firstCenterX;

      workflowTrack.style.setProperty("--workflow-line-x", Math.max(0, firstCenterX) + "px");
      workflowTrack.style.setProperty("--workflow-line-y", Math.max(0, firstCenterY) + "px");
      workflowTrack.style.setProperty("--workflow-line-length", Math.max(0, lineLength) + "px");
    }

    function scheduleWorkflowGeometryUpdate() {
      if (workflowGeometryFrame) return;
      workflowGeometryFrame = window.requestAnimationFrame(function () {
        workflowGeometryFrame = 0;
        updateWorkflowLineGeometry();
      });
    }

    function resetWorkflowAnimation() {
      workflowIsVisible = false;
      if (workflowAnimationFrame) {
        window.cancelAnimationFrame(workflowAnimationFrame);
        workflowAnimationFrame = 0;
      }
      workflowTrack.classList.remove("is-animating");
      workflowTrack.classList.add("is-resetting");
      void workflowTrack.offsetWidth;
    }

    function playWorkflowAnimation() {
      if (workflowIsVisible) return;
      workflowIsVisible = true;

      if (reduceMotion || !("IntersectionObserver" in window)) {
        workflowTrack.classList.remove("is-resetting");
        workflowTrack.classList.add("is-animating");
        return;
      }

      if (workflowAnimationFrame) window.cancelAnimationFrame(workflowAnimationFrame);
      workflowTrack.classList.remove("is-animating");
      workflowTrack.classList.add("is-resetting");
      void workflowTrack.offsetWidth;

      workflowAnimationFrame = window.requestAnimationFrame(function () {
        workflowAnimationFrame = window.requestAnimationFrame(function () {
          workflowAnimationFrame = 0;
          if (!workflowIsVisible) return;
          workflowTrack.classList.remove("is-resetting");
          workflowTrack.classList.add("is-animating");
        });
      });
    }

    updateWorkflowLineGeometry();
    window.addEventListener("resize", scheduleWorkflowGeometryUpdate, { passive: true });
    window.addEventListener("load", scheduleWorkflowGeometryUpdate, { once: true });

    if ("ResizeObserver" in window) {
      workflowResizeObserver = new ResizeObserver(scheduleWorkflowGeometryUpdate);
      workflowResizeObserver.observe(workflowTrack);
      workflowIcons.forEach(function (icon) {
        workflowResizeObserver.observe(icon);
      });
    }

    if (reduceMotion || !("IntersectionObserver" in window)) {
      playWorkflowAnimation();
    } else {
      workflowTrack.classList.add("is-resetting");
      workflowObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.target !== workflowTrack) return;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.12) {
            playWorkflowAnimation();
          } else {
            resetWorkflowAnimation();
          }
        });
      }, {
        threshold: [0, 0.12],
        rootMargin: "0px 0px -8% 0px"
      });
      workflowObserver.observe(workflowTrack);
    }

    window.addEventListener("pagehide", resetWorkflowAnimation);
    window.addEventListener("pageshow", function (event) {
      if (!event.persisted || !workflowObserver) return;
      resetWorkflowAnimation();
      workflowObserver.disconnect();
      workflowObserver.observe(workflowTrack);
      scheduleWorkflowGeometryUpdate();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        resetWorkflowAnimation();
        return;
      }
      var rect = workflowTrack.getBoundingClientRect();
      var visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      var visibleRatio = rect.height ? visibleHeight / rect.height : 0;
      if (visibleRatio >= 0.12) playWorkflowAnimation();
      else resetWorkflowAnimation();
    });
  }

  if (!("IntersectionObserver" in window) || reduceMotion) {
    revealItems.forEach(function (item) {
      item.classList.add("is-visible");
    });
  } else {
    var revealObserver = new IntersectionObserver(function (entries, observer) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.12,
      rootMargin: "0px 0px -35px 0px"
    });

    revealItems.forEach(function (item) {
      revealObserver.observe(item);
    });
  }

  var sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));
  if ("IntersectionObserver" in window && navLinks.length && sections.length) {
    var activeObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = entry.target.id;
        navLinks.forEach(function (link) {
          var active = link.getAttribute("href") === "#" + id;
          link.classList.toggle("active", active);
          if (active) link.setAttribute("aria-current", "location");
          else link.removeAttribute("aria-current");
        });
      });
    }, {
      rootMargin: "-25% 0px -60% 0px",
      threshold: 0
    });

    sections.forEach(function (section) {
      activeObserver.observe(section);
    });
  }

  // Standalone interactive product illustration; data are examples and never fetched from private archives.
  var demoGraphNodes = Array.prototype.slice.call(document.querySelectorAll("[data-graph-demo-node]"));
  var demoGraphTitle = document.getElementById("graphDemoTitle");
  var demoGraphType = document.getElementById("graphDemoType");
  var demoGraphDescription = document.getElementById("graphDemoDescription");
  demoGraphNodes.forEach(function (node) {
    node.addEventListener("click", function () {
      demoGraphNodes.forEach(function (other) {
        var active = other === node;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-pressed", String(active));
      });
      if (demoGraphTitle) demoGraphTitle.textContent = node.getAttribute("data-name") || "";
      if (demoGraphType) demoGraphType.textContent = node.getAttribute("data-type") || "";
      if (demoGraphDescription) demoGraphDescription.textContent = node.getAttribute("data-detail") || "";
    });
  });

  var faqItems = Array.prototype.slice.call(document.querySelectorAll(".faq-item"));
  faqItems.forEach(function (item) {
    item.addEventListener("toggle", function () {
      if (!item.open) return;
      faqItems.forEach(function (other) {
        if (other !== item) other.open = false;
      });
    });
  });

  window.addEventListener("resize", function () {
    if (window.innerWidth > 900) closeNav();
  }, { passive: true });
})();