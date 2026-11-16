/* Self-contained, local-only product demonstration. No business API calls. */
(function () {
  "use strict";

  var showcase = document.getElementById("heroShowcase");
  if (!showcase) return;

  var tabs = Array.prototype.slice.call(showcase.querySelectorAll("[data-showcase-target]"));
  var screens = Array.prototype.slice.call(showcase.querySelectorAll("[data-showcase-screen]"));
  var dots = Array.prototype.slice.call(showcase.querySelectorAll(".showcase-dots i"));
  var label = document.getElementById("showcaseCurrentLabel");
  var playButton = document.getElementById("showcasePlayToggle");
  var display = showcase.querySelector(".showcase-display");
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var canHover = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var delay = 3000;
  var selectedIndex = 0;
  var timer = null;
  var visibility = true;
  var hovered = false;
  var focusInside = false;
  var userPaused = false;
  var motionFrame = 0;

  function canRun() {
    return !reduced && !userPaused && !hovered && !focusInside && visibility && !document.hidden;
  }

  function stopTimer() {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    stopTimer();
    if (!canRun()) return;
    timer = window.setTimeout(function () {
      timer = null;
      select((selectedIndex + 1) % tabs.length);
      schedule();
    }, delay);
  }

  function syncPlayButton() {
    if (!playButton) return;
    if (reduced) {
      playButton.textContent = "手动浏览";
      playButton.disabled = true;
      playButton.setAttribute("aria-label", "已根据系统偏好关闭自动轮播");
      return;
    }
    var paused = userPaused;
    playButton.innerHTML = paused ? '播放 <span aria-hidden="true">▶</span>' : '暂停 <span aria-hidden="true">Ⅱ</span>';
    playButton.setAttribute("aria-pressed", String(paused));
    playButton.setAttribute("aria-label", paused ? "恢复自动切换" : "暂停自动切换");
  }

  function select(index) {
    if (!tabs.length || index < 0 || index >= tabs.length) return;
    selectedIndex = index;
    var key = tabs[index].getAttribute("data-showcase-target");
    tabs.forEach(function (tab, i) {
      var active = i === index;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    if (motionFrame) {
      window.cancelAnimationFrame(motionFrame);
      motionFrame = 0;
    }
    screens.forEach(function (screen) {
      var active = screen.getAttribute("data-showcase-screen") === key;
      screen.classList.remove("is-active");
      screen.hidden = !active;
    });
    var screen = screens.filter(function (s) { return s.getAttribute("data-showcase-screen") === key; })[0];
    if (screen) {
      if (reduced) screen.classList.add("is-active");
      else motionFrame = window.requestAnimationFrame(function () {
        motionFrame = 0;
        screen.classList.add("is-active");
      });
    }
    dots.forEach(function (dot, i) { dot.classList.toggle("is-active", i === index); });
    if (label) label.textContent = tabs[index].querySelector("strong").textContent.trim() + " · 演示数据";
    showcase.setAttribute("data-active-showcase", key);
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () {
      select(index);
      schedule();
    });
    tab.addEventListener("keydown", function (event) {
      var next = index;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next);
      tabs[next].focus();
      schedule();
    });
  });

  showcase.addEventListener("mouseenter", function () {
    if (!canHover) return;
    hovered = true;
    schedule();
  });
  showcase.addEventListener("mouseleave", function () {
    if (!canHover) return;
    hovered = false;
    schedule();
  });
  showcase.addEventListener("focusin", function (event) {
    // Mouse/touch clicks should not permanently pause autoplay through focus.
    focusInside = event.target.matches(":focus-visible");
    schedule();
  });
  showcase.addEventListener("focusout", function () {
    window.setTimeout(function () {
      focusInside = showcase.contains(document.activeElement) &&
        document.activeElement.matches(":focus-visible");
      schedule();
    }, 0);
  });

  if (playButton) {
    playButton.addEventListener("click", function () {
      if (reduced) return;
      userPaused = !userPaused;
      syncPlayButton();
      schedule();
    });
  }

  if (display) {
    var startX = 0;
    var startY = 0;
    display.addEventListener("touchstart", function (event) {
      if (!event.touches.length) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
    }, { passive: true });
    display.addEventListener("touchend", function (event) {
      if (!event.changedTouches.length) return;
      var dx = event.changedTouches[0].clientX - startX;
      var dy = event.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < 35 || Math.abs(dx) < Math.abs(dy)) return;
      select((selectedIndex + (dx < 0 ? 1 : tabs.length - 1)) % tabs.length);
      schedule();
    }, { passive: true });
  }

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      visibility = entries[0].isIntersecting;
      schedule();
    }, { threshold: .12 });
    observer.observe(showcase);
  }
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("pagehide", stopTimer);
  window.addEventListener("pageshow", schedule);

  select(0);
  syncPlayButton();
  schedule();
})();
